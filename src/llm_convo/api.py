import asyncio
import json
import time
import uuid
from contextlib import asynccontextmanager
from pathlib import Path
from typing import Annotated, Any

from dotenv import load_dotenv
from fastapi import FastAPI, Header, HTTPException, Query, Request, status
from fastapi.encoders import jsonable_encoder
from fastapi.responses import FileResponse, StreamingResponse
from fastapi.staticfiles import StaticFiles
from sqlalchemy import text

from llm_convo.config import Settings, get_settings
from llm_convo.db import create_engine, create_session_factory, init_database
from llm_convo.llm import OpenAICompatibleClient
from llm_convo.logging import configure_logging
from llm_convo.models import Conversation, ConversationStatus
from llm_convo.realtime import RealtimeBroker, RealtimeEvent
from llm_convo.runner import ConversationRunner
from llm_convo.schemas import (
    ConversationCreated,
    ConversationPage,
    ConversationSummary,
    ConversationView,
    EndConversationResponse,
    EventView,
    HealthResponse,
    LangfuseView,
    MessagePage,
    MessageView,
    SnapshotView,
    StartConversationRequest,
)
from llm_convo.service import ConversationService, IdempotencyConflictError
from llm_convo.tracing import Tracing

STATIC_DIR = Path(__file__).parent / "static"


def _conversation_view(conversation: Conversation, tracing: Tracing) -> ConversationView:
    conversation_id = str(conversation.id)
    return ConversationView.model_validate(conversation).model_copy(
        update={
            "langfuse_trace_id": tracing.trace_id(conversation_id),
            "langfuse_url": tracing.trace_url(conversation_id),
        }
    )


def _conversation_summary(conversation: Conversation) -> ConversationSummary:
    return ConversationSummary(
        id=conversation.id,
        status=conversation.status,
        task_prompt=conversation.task_prompt,
        turn_count=conversation.turn_count,
        next_speaker=conversation.next_speaker,
        created_at=conversation.created_at,
        updated_at=conversation.updated_at,
        ended_at=conversation.ended_at,
        error=conversation.error,
        agent_a_model=conversation.config["agent_a"]["model"],
        agent_b_model=conversation.config["agent_b"]["model"],
    )


def _sse(event: str, data: dict[str, Any], event_id: str | None = None) -> str:
    payload = json.dumps(jsonable_encoder(data), ensure_ascii=False, separators=(",", ":"))
    id_line = f"id: {event_id}\n" if event_id else ""
    return f"{id_line}event: {event}\ndata: {payload}\n\n"


def create_app(settings: Settings | None = None) -> FastAPI:
    settings = settings or get_settings()
    # Agent credentials are referenced by environment-variable name. Settings are
    # resolved first so .env.langfuse can override only its own Langfuse values.
    load_dotenv(".env", override=False)
    load_dotenv(".env.langfuse", override=False)
    configure_logging(settings.log_level)
    engine = create_engine(settings.database_url)
    sessions = create_session_factory(engine)
    llm = OpenAICompatibleClient()
    tracing = Tracing(
        public_key=settings.langfuse_public_key,
        secret_key=settings.langfuse_secret_key,
        base_url=settings.langfuse_base_url,
        public_url=settings.langfuse_public_url,
        project_id=settings.langfuse_project_id,
        environment=settings.langfuse_tracing_environment,
    )
    realtime = RealtimeBroker()
    service = ConversationService(sessions)
    runner = ConversationRunner(
        sessions,
        llm,
        tracing,
        realtime,
        poll_seconds=settings.worker_poll_seconds,
        lease_seconds=settings.worker_lease_seconds,
        heartbeat_seconds=settings.worker_heartbeat_seconds,
        max_concurrent_conversations=settings.max_concurrent_conversations,
    )

    @asynccontextmanager
    async def lifespan(app: FastAPI):
        if settings.database_auto_create:
            await init_database(engine)
        await runner.start()
        yield
        await runner.shutdown(settings.shutdown_grace_seconds)
        await llm.close()
        tracing.shutdown()
        await engine.dispose()

    app = FastAPI(
        title="LLM Conversation Platform",
        version="0.1.0",
        lifespan=lifespan,
    )
    app.state.settings = settings
    app.state.engine = engine
    app.state.service = service
    app.state.runner = runner
    app.state.tracing = tracing
    app.state.realtime = realtime

    app.mount("/assets", StaticFiles(directory=STATIC_DIR), name="assets")

    @app.get("/", include_in_schema=False)
    async def frontend() -> FileResponse:
        return FileResponse(
            STATIC_DIR / "index.html",
            headers={"Cache-Control": "no-cache"},
        )

    async def start_conversation(
        body: StartConversationRequest,
        request: Request,
        idempotency_key: str | None = Header(default=None, alias="Idempotency-Key"),
    ) -> ConversationCreated:
        if not idempotency_key or not idempotency_key.strip():
            raise HTTPException(
                status_code=status.HTTP_428_PRECONDITION_REQUIRED,
                detail="Idempotency-Key header is required",
            )
        if len(idempotency_key) > 255:
            raise HTTPException(status_code=400, detail="Idempotency-Key is too long")
        try:
            result = await request.app.state.service.create(body, idempotency_key.strip())
        except IdempotencyConflictError as exc:
            raise HTTPException(status_code=409, detail=str(exc)) from exc
        request.app.state.runner.enqueue(result.conversation.id)
        if not result.deduplicated:
            await request.app.state.realtime.publish(
                result.conversation.id,
                "conversation_queued",
                {"status": result.conversation.status},
            )
        return ConversationCreated(
            conversation_id=result.conversation.id,
            status=result.conversation.status,
            deduplicated=result.deduplicated,
        )

    app.post(
        "/v1/conversations",
        response_model=ConversationCreated,
        status_code=status.HTTP_202_ACCEPTED,
    )(start_conversation)
    app.post(
        "/start_convo",
        response_model=ConversationCreated,
        status_code=status.HTTP_202_ACCEPTED,
        include_in_schema=False,
    )(start_conversation)

    @app.get("/v1/conversations", response_model=ConversationPage)
    async def list_conversations(
        request: Request,
        conversation_status: Annotated[
            ConversationStatus | None, Query(alias="status")
        ] = None,
        limit: int = Query(default=50, ge=1, le=200),
        offset: int = Query(default=0, ge=0),
    ) -> ConversationPage:
        items, total = await request.app.state.service.list_conversations(
            status=conversation_status, limit=limit, offset=offset
        )
        return ConversationPage(
            items=[_conversation_summary(item) for item in items],
            total=total,
            limit=limit,
            offset=offset,
        )

    @app.get("/v1/conversations/{conversation_id}", response_model=ConversationView)
    async def get_conversation(conversation_id: uuid.UUID, request: Request) -> ConversationView:
        conversation = await request.app.state.service.get(conversation_id)
        if conversation is None:
            raise HTTPException(status_code=404, detail="Conversation not found")
        return _conversation_view(conversation, request.app.state.tracing)

    async def end_conversation(
        conversation_id: uuid.UUID, request: Request
    ) -> EndConversationResponse:
        conversation = await request.app.state.service.request_stop(conversation_id)
        if conversation is None:
            raise HTTPException(status_code=404, detail="Conversation not found")
        request.app.state.runner.cancel(conversation_id)
        current = await request.app.state.service.get(conversation_id)
        await request.app.state.realtime.publish(
            conversation_id,
            "conversation_stopped",
            {
                "status": current.status if current else conversation.status,
                "turn_count": current.turn_count if current else conversation.turn_count,
            },
        )
        return EndConversationResponse(
            conversation_id=conversation_id,
            status=current.status if current else conversation.status,
        )

    app.post("/v1/conversations/{conversation_id}/end", response_model=EndConversationResponse)(
        end_conversation
    )
    app.post(
        "/end_convo/{conversation_id}",
        response_model=EndConversationResponse,
        include_in_schema=False,
    )(end_conversation)

    @app.get("/v1/conversations/{conversation_id}/messages", response_model=MessagePage)
    async def get_messages(
        conversation_id: uuid.UUID,
        request: Request,
        after_sequence: int = Query(default=0, ge=0),
        limit: int = Query(default=100, ge=1, le=1000),
    ) -> MessagePage:
        items = await request.app.state.service.messages(
            conversation_id, after_sequence, limit
        )
        if items is None:
            raise HTTPException(status_code=404, detail="Conversation not found")
        return MessagePage(
            items=[MessageView.model_validate(item) for item in items],
            next_after_sequence=items[-1].sequence if len(items) == limit else None,
        )

    @app.get("/v1/conversations/{conversation_id}/events", response_model=list[EventView])
    async def get_events(
        conversation_id: uuid.UUID,
        request: Request,
        limit: int = Query(default=1000, ge=1, le=5000),
    ) -> list[EventView]:
        items = await request.app.state.service.events(conversation_id, limit)
        if items is None:
            raise HTTPException(status_code=404, detail="Conversation not found")
        return [EventView.model_validate(item) for item in items]

    @app.get(
        "/v1/conversations/{conversation_id}/context-snapshots",
        response_model=list[SnapshotView],
    )
    async def get_snapshots(
        conversation_id: uuid.UUID, request: Request
    ) -> list[SnapshotView]:
        items = await request.app.state.service.snapshots(conversation_id)
        if items is None:
            raise HTTPException(status_code=404, detail="Conversation not found")
        return [SnapshotView.model_validate(item) for item in items]

    @app.get(
        "/v1/conversations/{conversation_id}/langfuse",
        response_model=LangfuseView,
    )
    async def get_langfuse(
        conversation_id: uuid.UUID,
        request: Request,
        limit: int = Query(default=100, ge=1, le=1000),
    ) -> LangfuseView:
        conversation = await request.app.state.service.get(conversation_id)
        if conversation is None:
            raise HTTPException(status_code=404, detail="Conversation not found")
        tracing: Tracing = request.app.state.tracing
        trace_id = tracing.trace_id(str(conversation_id))
        observations, error = await tracing.observations(str(conversation_id), limit=limit)
        return LangfuseView(
            enabled=tracing.enabled,
            trace_id=trace_id,
            url=tracing.trace_url(str(conversation_id)),
            observations=observations,
            error=error,
        )

    @app.get("/v1/conversations/{conversation_id}/stream")
    async def stream_conversation(
        conversation_id: uuid.UUID, request: Request
    ) -> StreamingResponse:
        if await request.app.state.service.get(conversation_id) is None:
            raise HTTPException(status_code=404, detail="Conversation not found")

        async def generate():
            service: ConversationService = request.app.state.service
            broker: RealtimeBroker = request.app.state.realtime
            tracing: Tracing = request.app.state.tracing
            async with broker.subscribe(conversation_id) as queue:
                conversation = await service.get(conversation_id)
                if conversation is None:
                    return
                last_sequence = conversation.turn_count
                last_status = conversation.status
                snapshots = await service.snapshots(conversation_id) or []
                last_snapshot_version = snapshots[-1].version if snapshots else 0
                durable_events = await service.recent_events(conversation_id) or []
                seen_event_ids = {item.id for item in durable_events}
                yield _sse(
                    "ready",
                    {
                        "conversation": _conversation_view(conversation, tracing),
                        "last_sequence": last_sequence,
                    },
                    uuid.uuid4().hex,
                )
                next_reconcile = time.monotonic() + 1.0
                last_emit = time.monotonic()

                while not await request.is_disconnected():
                    timeout = max(0.0, next_reconcile - time.monotonic())
                    try:
                        live: RealtimeEvent = await asyncio.wait_for(queue.get(), timeout=timeout)
                    except TimeoutError:
                        live = None  # type: ignore[assignment]
                    if live is not None:
                        durable_event_id = live.data.get("durable_event_id")
                        if durable_event_id:
                            try:
                                seen_event_ids.add(uuid.UUID(str(durable_event_id)))
                            except ValueError:
                                pass
                        yield _sse(
                            live.event,
                            {**live.data, "created_at": live.created_at, "source": "live"},
                            live.id,
                        )
                        last_emit = time.monotonic()
                        if live.event == "turn_completed" and live.data.get("message"):
                            last_sequence = max(
                                last_sequence, int(live.data["message"]["sequence"])
                            )
                        continue

                    new_messages = (
                        await service.messages(conversation_id, last_sequence, 1000) or []
                    )
                    for message in new_messages:
                        last_sequence = message.sequence
                        yield _sse(
                            "turn_completed",
                            {
                                "message": MessageView.model_validate(message),
                                "source": "database",
                            },
                            f"message-{message.id}",
                        )
                        last_emit = time.monotonic()

                    recent_events = await service.recent_events(conversation_id) or []
                    for durable in recent_events:
                        if durable.id in seen_event_ids:
                            continue
                        seen_event_ids.add(durable.id)
                        yield _sse(
                            durable.event_type,
                            {
                                **durable.payload,
                                "durable_event_id": durable.id,
                                "created_at": durable.created_at,
                                "source": "database",
                            },
                            f"event-{durable.id}",
                        )
                        last_emit = time.monotonic()

                    fresh_snapshots = await service.snapshots(conversation_id) or []
                    for snapshot in fresh_snapshots:
                        if snapshot.version <= last_snapshot_version:
                            continue
                        last_snapshot_version = snapshot.version
                        yield _sse(
                            "context_compressed",
                            {
                                "snapshot": SnapshotView.model_validate(snapshot),
                                "source": "database",
                            },
                            f"snapshot-{snapshot.id}",
                        )
                        last_emit = time.monotonic()

                    conversation = await service.get(conversation_id)
                    if conversation is None:
                        return
                    if conversation.status != last_status:
                        last_status = conversation.status
                        yield _sse(
                            "conversation_status",
                            {
                                "status": last_status,
                                "turn_count": conversation.turn_count,
                                "error": conversation.error,
                            },
                            uuid.uuid4().hex,
                        )
                        last_emit = time.monotonic()
                    if time.monotonic() - last_emit >= 15:
                        yield ": heartbeat\n\n"
                        last_emit = time.monotonic()
                    next_reconcile = time.monotonic() + 1.0

        return StreamingResponse(
            generate(),
            media_type="text/event-stream",
            headers={
                "Cache-Control": "no-cache, no-transform",
                "Connection": "keep-alive",
                "X-Accel-Buffering": "no",
            },
        )

    @app.get("/health/live", response_model=HealthResponse)
    async def liveness(request: Request) -> HealthResponse:
        return HealthResponse(
            status="ok",
            database="ok",
            langfuse="configured" if request.app.state.tracing.enabled else "disabled",
        )

    @app.get("/health/ready", response_model=HealthResponse)
    async def readiness(request: Request) -> HealthResponse:
        database_status = "ok"
        try:
            async with sessions() as session:
                await session.execute(text("SELECT 1"))
        except Exception:
            database_status = "error"
        langfuse_status = await request.app.state.tracing.health()
        return HealthResponse(
            status=(
                "ok"
                if database_status == "ok" and langfuse_status != "error"
                else "degraded"
            ),
            database=database_status,
            langfuse=langfuse_status,
        )

    return app


app = create_app()
