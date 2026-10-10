# Circuits (P1 deferred)

P0 uses hash + dual ECDSA + `IVerifier` / `StubVerifier` (ECDSA-only).

**P1 upgrade path:** circom/Noir `covenant_preimage` proving knowledge of seats+clauses without revealing them at activation (G1→ stronger privacy).

Do **not** advertise StubVerifier as full ZK.
