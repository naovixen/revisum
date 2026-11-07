// Why the plan parser refused a plan: a code and the JSON path it applies to, never the offending
// value, so hostile or private text is never echoed back. Plan codes use underscores.
export const PlanErrorCode = {
    NotObject: "not_object",
    UnknownField: "unknown_field",
    MissingField: "missing_field",
    WrongType: "wrong_type",
    UnknownStep: "unknown_step",
    UnknownValue: "unknown_value",
    InvalidUrl: "invalid_url",
    SchemeNotAllowed: "scheme_not_allowed",
    OriginNotAllowed: "origin_not_allowed",
    TargetNotInMatrix: "target_not_in_matrix",
    UnsafeText: "unsafe_text",
    TooLarge: "too_large",
    TooLong: "too_long",
    Duplicate: "duplicate",
    VersionUnsupported: "version_unsupported",
    Empty: "empty",
    // A check that would pass on anything, such as an expected text that is empty.
    Vacuous: "vacuous",
    // A secret written into the plan: literal text in a sensitive field, credential-shaped text, or
    // saved storage state itself. A plan names secrets with { secretName }.
    LiteralSecret: "literal_secret",
    // A reference to a run value that no earlier part of the plan defines.
    UndefinedValue: "undefined_value",
    // A position on the locator of a check that counts matches (countEquals or absent), where
    // picking one element would make the count meaningless.
    PositionNotAllowed: "position_not_allowed",
    // A step where the language does not allow it, such as a newTab inside a frame or another newTab.
    MisplacedStep: "misplaced_step",
    // A call declaration that writes a parameter into a string, when the parameter's type could
    // hold a quote, a space or a separator and so change what the string says.
    UnsafeInterpolation: "unsafe_interpolation",
    // A call declaration that sets a header deciding where or how a request travels, such as host.
    HeaderNotAllowed: "header_not_allowed",
    // A suite declaration whose command does not invoke Playwright Test, or sets an argument Revisum
    // sets itself.
    CommandNotAllowed: "command_not_allowed",
    // A suite declaration's path or working directory that is absolute or leaves the repository, or
    // a page script declaration's file outside plans/scripts/.
    PathNotAllowed: "path_not_allowed",
    // An unsafe plan feature, such as a css locator or a page script, that the trusted project does
    // not enable. Reported at the field that names the feature, with nothing under it read.
    UnsafeFeatureDisabled: "unsafe_feature_disabled",
    // A local planner endpoint whose host is not on the loopback interface.
    NotLoopback: "not_loopback",
} as const;

export type PlanErrorCode = (typeof PlanErrorCode)[keyof typeof PlanErrorCode];

export type PlanError = { readonly code: PlanErrorCode; readonly path: string };
