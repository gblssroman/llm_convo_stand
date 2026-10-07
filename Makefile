LANGFUSE_COMPOSE = docker compose

.PHONY: up down status logs langfuse-init langfuse-up langfuse-down langfuse-status langfuse-logs langfuse-smoke

up: .env.langfuse
	$(LANGFUSE_COMPOSE) up -d --build --wait --wait-timeout 300

down:
	$(LANGFUSE_COMPOSE) down

status:
	$(LANGFUSE_COMPOSE) ps

logs:
	$(LANGFUSE_COMPOSE) logs -f app langfuse-web langfuse-worker

langfuse-init:
	./scripts/init-langfuse.sh

langfuse-up: up

langfuse-down:
	$(MAKE) down

langfuse-status:
	$(MAKE) status

langfuse-logs:
	$(MAKE) logs

langfuse-smoke:
	uv run --extra langfuse python scripts/langfuse-smoke.py

.env.langfuse:
	./scripts/init-langfuse.sh
