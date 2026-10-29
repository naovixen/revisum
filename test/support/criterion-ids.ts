// Spec and criterion ids built at run time. The naming lint allows a criterion id in test source
// only as a test's `criterion` value, so tests that need one as data (a commit trailer, a fixture
// spec, a planted file) build it here instead of writing it out.
const twoDigits = (value: number): string => String(value).padStart(2, '0');

// "SPEC-07" for 7.
export const specId = (spec: number): string => `SPEC-${twoDigits(spec)}`;

// The criterion id for spec 7, criterion 3 is "AC-" then specId(7) then "-03".
export const criterionId = (spec: number, criterion: number): string => `AC-${specId(spec)}-${twoDigits(criterion)}`;
