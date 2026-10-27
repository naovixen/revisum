# auditor-act

Our own accessibility engine, built on the W3C Accessibility Conformance Testing (ACT) rules, with keyboard and pointer probes for criteria no ACT rule covers. It runs beside axe-core, which stays its reference.

It drives Chromium through `driver-cdp`'s CDP connection and launcher, and otherwise imports only `contracts` and Node built-ins. `data/` holds the IANA language subtag registry the language rules read. Licence: FSL-1.1-ALv2.
