# engine

The trusted core: parses plans, checks trust and policy, runs the lifecycle and interpreter, decides results, hashes, redacts and records.

It imports only `contracts` and Node built-ins and has no runtime dependencies; the compiler and `tools/check-imports.ts` enforce both. Licence: FSL-1.1-ALv2.
