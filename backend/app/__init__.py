"""India Manufacturing Atlas - FastAPI application package (docs/SPEC.md sections 1, 5 and 6).

Run from ``backend/``::

    uvicorn app.main:app --port 8000

Module map (owner C1 unless noted):

* ``app.config``   - settings read from the environment (``ATLAS_DB``, ``ATLAS_JWT_SECRET`` ...).
* ``app.db``       - per-request SQLite connection dependency and small query helpers.
* ``app.security`` - password hashing, HS256 JWT, ``current_user`` / ``require_roles`` dependencies.
* ``app.common``   - shared response builders (``ProductSummary``, ``CountryValue``, provenance ...).
* ``app.routers``  - one ``APIRouter`` per area; ``app.main`` includes the fixed list from SPEC section 2.
* ``app.services`` - domain services (``audit`` here; scoring / reports / connectors by C2 and C3).
"""

__version__ = "1.0.0"
