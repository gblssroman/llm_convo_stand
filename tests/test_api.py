from fastapi.testclient import TestClient

from llm_convo.api import create_app
from llm_convo.config import Settings


def test_frontend_and_empty_history_are_served(tmp_path) -> None:
    database_url = f"sqlite+aiosqlite:///{tmp_path / 'api.sqlite3'}"
    app = create_app(
        Settings(
            database_url=database_url,
            langfuse_public_key=None,
            langfuse_secret_key=None,
            worker_poll_seconds=60,
        )
    )

    with TestClient(app) as client:
        frontend = client.get("/")
        stylesheet = client.get("/assets/app.css")
        javascript = client.get("/assets/app.js")
        markdown = client.get("/assets/markdown.js")
        health = client.get("/health/ready")
        history = client.get("/v1/conversations")

    assert frontend.status_code == 200
    assert "Agent Relay" in frontend.text
    assert 'name="agent_a_base_url"' in frontend.text
    assert 'name="agent_b_base_url"' in frontend.text
    assert 'name="agent_a_model"' in frontend.text
    assert 'name="agent_b_model"' in frontend.text
    assert 'name="agent_a_top_p" type="number" min="0.01" max="1" step="0.01"' in frontend.text
    assert 'name="agent_b_top_p" type="number" min="0.01" max="1" step="0.01"' in frontend.text
    assert frontend.text.count("Generation and context settings") == 2
    assert frontend.headers["cache-control"] == "no-cache"
    assert stylesheet.status_code == 200
    assert ".message-stream" in stylesheet.text
    assert "overflow-y: auto" in stylesheet.text
    assert "@keyframes" not in stylesheet.text
    assert "animation:" not in stylesheet.text
    assert javascript.status_code == 200
    assert "function updateLiveMessage" in javascript.text
    assert "followLiveOutput" in javascript.text
    assert 'event.deltaY < 0' in javascript.text
    assert markdown.status_code == 200
    assert "function renderMarkdown" in markdown.text
    assert "escapeHtml" in markdown.text
    assert "function renderTable" in markdown.text
    assert ".markdown-table-wrap" in stylesheet.text
    assert "/assets/markdown.js?v=markdown-tables-1" in frontend.text
    assert "system-dot" not in frontend.text
    assert "Backend status" in frontend.text
    assert 'id="database-status"' in frontend.text
    assert 'id="langfuse-status"' in frontend.text
    assert "database-label" not in frontend.text
    assert "langfuse-label" not in frontend.text
    assert health.json() == {"status": "ok", "database": "ok", "langfuse": "disabled"}
    assert history.status_code == 200
    assert history.json() == {"items": [], "total": 0, "limit": 50, "offset": 0}
