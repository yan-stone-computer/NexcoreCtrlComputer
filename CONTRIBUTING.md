# Contributing

Keep the control plane small and evidence-driven.

1. Read the affected backend's documented contract before changing an adapter.
2. Add tests for snapshot compaction, policy, retries, or protocol behavior.
3. Run `npm test` and `npm run bench`.
4. Verify at least one real action path on your platform when changing adapter
   arguments.
5. Do not copy upstream source without preserving its license and notices.
6. Keep semantic programs portable: no coordinates, snapshot refs, or captured
   screenshots in stored definitions.

Good changes reduce a round trip, improve fail-closed behavior, or make real UI
state easier to verify. New abstractions need a concrete caller and test.
