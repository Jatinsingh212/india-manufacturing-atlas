"""API routers. Each module exposes ``router = APIRouter(prefix="/api/...", tags=[...])``.

``app.main`` imports this fixed list (docs/SPEC.md section 2) and skips, with a logged warning, any module that
is missing or fails to import, so parallel builders can land their routers independently.
"""

ROUTER_MODULES = (
    "auth", "meta", "hsn", "ministries", "sectors", "valuechains", "network", "analytics", "policy", "risk",
    "residual", "tickets", "datahub", "reports", "admin", "assistant", "deepdive", "sync", "workflow",
)
