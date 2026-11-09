// The code rules. Layout belongs to Prettier and isn't checked here. Each restricted-syntax message
// says what to write instead, so the error teaches the rule. Why each rule is here, and what was
// left out: docs/decisions/code-conventions.md.
import js from "@eslint/js";
import { defineConfig, globalIgnores } from "eslint/config";
import tseslint from "typescript-eslint";
import { fileNameMatchesExport } from "./FileNameMatchesExport.ts";
import { inPageFunctionsAreSelfContained } from "./InPageFunctionsAreSelfContained.ts";
import { testTitleFormat } from "./TestTitleFormat.ts";

const GENERIC_NAME_ENDINGS = "(Manager|Helper|Util|Utils)$";

// The files whose top-level functions run inside the page. The in-page rule checks that each uses
// nothing from its module, and that no other file sends a function to the page.
const IN_PAGE_FILES = [
    "packages/auditor-act/src/in-page/ActiveElementHolder.ts",
    "packages/auditor-act/src/in-page/DocumentWidths.ts",
    "packages/auditor-act/src/in-page/FocusThisElement.ts",
    "packages/auditor-act/src/in-page/HoldFocusedElement.ts",
    "packages/auditor-act/src/in-page/MeasureOcclusion.ts",
    "packages/auditor-act/src/in-page/HideSampledText.ts",
    "packages/auditor-act/src/in-page/SettleFrames.ts",
    "packages/driver-cdp/src/in-page/elements/Actionability.ts",
    "packages/driver-cdp/src/in-page/document/AdvanceDocumentClock.ts",
    "packages/driver-cdp/src/in-page/document/AfterTwoFrames.ts",
    "packages/driver-cdp/src/in-page/elements/ArmHitCheck.ts",
    "packages/driver-cdp/src/in-page/elements/EnabledState.ts",
    "packages/driver-cdp/src/in-page/elements/FindByLabel.ts",
    "packages/driver-cdp/src/in-page/elements/FocusAndSelect.ts",
    "packages/driver-cdp/src/in-page/elements/GuardDetails.ts",
    "packages/driver-cdp/src/in-page/elements/MaskElements.ts",
    "packages/driver-cdp/src/in-page/elements/NodesAPressPasses.ts",
    "packages/driver-cdp/src/in-page/document/PageAudit.ts",
    "packages/driver-cdp/src/in-page/document/PageInfo.ts",
    "packages/driver-cdp/src/in-page/elements/ProbeElement.ts",
    "packages/driver-cdp/src/in-page/document/ReadClipboardText.ts",
    "packages/driver-cdp/src/in-page/document/ScriptResultText.ts",
    "packages/driver-cdp/src/in-page/elements/StructuralSelectorValidity.ts",
    "packages/driver-cdp/src/in-page/document/WindowOfTheDocument.ts",
];

const everywhereSyntax = [
    {
        selector:
            "PropertyDefinition[accessibility='private'], MethodDefinition[accessibility='private']",
        message: "Use #private, which is enforced at run time, not TypeScript's private.",
    },
    {
        selector:
            "MethodDefinition[kind='get'], MethodDefinition[kind='set'], Property[kind='get'], Property[kind='set']",
        message: "Use a named method such as getAge() or setAge(), not a getter or setter.",
    },
    { selector: "ExportDefaultDeclaration", message: "Use a named export." },
    { selector: "ImportNamespaceSpecifier", message: "Import the names you use, not import *." },
    {
        selector: "ExportNamedDeclaration[declaration=null][source=null]",
        message: "Export each item where it is declared, not in an export list.",
    },
    {
        selector: "ExportNamedDeclaration > VariableDeclaration[kind='let']",
        message: "Export a const, not a let.",
    },
    {
        selector: "TSEnumDeclaration",
        message:
            "Use a union of string literals: Node runs this code without a build step and rejects enums.",
    },
    {
        selector: "Program > :not(ImportDeclaration) ~ ImportDeclaration",
        message: "Put all imports at the top of the file.",
    },
];

const noExportStar = {
    selector: "ExportAllDeclaration",
    message: "Use export * only in a package's index.ts.",
};

const NON_EMPTY_STRING = "Literal[value=/[\\s\\S]/]";
const FIXED_VALUE_PROPERTY = "(type|kind|code|outcome|state)";
const useNamedConstant =
    "Use the member of the value's constant object, not a string literal: .claude/rules/typescript.md.";

const noMagicStrings = [
    {
        selector: `BinaryExpression[operator=/^[!=]==$/]:not([left.operator='typeof']):not([right.operator='typeof']) > ${NON_EMPTY_STRING}`,
        message: useNamedConstant,
    },
    {
        selector: `SwitchStatement:not([discriminant.operator='typeof']) > SwitchCase > ${NON_EMPTY_STRING}`,
        message: useNamedConstant,
    },
    {
        selector: `Property[computed=false]:matches([key.name=/^${FIXED_VALUE_PROPERTY}$/], [key.value=/^${FIXED_VALUE_PROPERTY}$/]) > ${NON_EMPTY_STRING}.value`,
        message: useNamedConstant,
    },
];

export default defineConfig([
    globalIgnores([
        "**/dist/**",
        "**/node_modules/**",
        "**/*.d.ts",
        "fixtures/**",
        "golden/**",
        "test/fixtures/**",
        "test/golden/**",
        "temp/**",
        ".browsers/**",
    ]),
    {
        files: ["packages/**/*.ts", "tools/**/*.ts", "test/**/*.ts"],
        extends: [js.configs.recommended, tseslint.configs.recommendedTypeChecked],
        languageOptions: {
            parserOptions: { projectService: true, tsconfigRootDir: process.cwd() },
        },
        plugins: {
            revisum: {
                rules: {
                    "file-name-matches-export": fileNameMatchesExport,
                    "in-page-functions-are-self-contained": inPageFunctionsAreSelfContained,
                    "test-title-format": testTitleFormat,
                },
            },
        },
        rules: {
            "revisum/file-name-matches-export": "error",

            "no-else-return": "error",
            "no-case-declarations": "error",
            "no-nested-ternary": "error",
            "no-unneeded-ternary": "error",
            "array-callback-return": "error",

            "no-var": "error",
            "prefer-const": "error",
            "one-var": ["error", "never"],
            "no-multi-assign": "error",
            "no-param-reassign": "error",
            "no-return-assign": "error",

            eqeqeq: "error",
            "no-implicit-coercion": ["error", { allow: ["!!"] }],
            "no-restricted-globals": [
                "error",
                { name: "isNaN", message: "Use Number.isNaN, which doesn't coerce." },
                { name: "isFinite", message: "Use Number.isFinite, which doesn't coerce." },
            ],
            radix: "error",

            "object-shorthand": "error",
            "prefer-object-has-own": "error",
            "prefer-object-spread": "error",
            "prefer-rest-params": "error",
            "prefer-spread": "error",
            "prefer-template": "error",
            "no-useless-escape": "error",

            "no-eval": "error",
            "no-new-func": "error",
            "no-new-wrappers": "error",
            "no-object-constructor": "error",

            "max-lines": ["error", { max: 400, skipBlankLines: true, skipComments: true }],
            "max-lines-per-function": [
                "error",
                { max: 75, skipBlankLines: true, skipComments: true },
            ],
            "no-duplicate-imports": ["error", { allowSeparateTypeImports: true }],

            "no-restricted-syntax": ["error", ...everywhereSyntax, noExportStar],

            // These replace the core rules of the same name, which misread TypeScript.
            "default-param-last": "off",
            "@typescript-eslint/default-param-last": "error",
            "dot-notation": "off",
            // Brackets stay allowed on records: decoders read unverified keys that way on purpose.
            "@typescript-eslint/dot-notation": [
                "error",
                { allowIndexSignaturePropertyAccess: true },
            ],
            "no-useless-constructor": "off",
            "@typescript-eslint/no-useless-constructor": "error",

            "@typescript-eslint/prefer-nullish-coalescing": "error",
            "@typescript-eslint/no-unnecessary-condition": "error",
            "@typescript-eslint/strict-boolean-expressions": [
                "error",
                { allowString: false, allowNumber: false, allowNullableObject: false },
            ],
            "@typescript-eslint/no-floating-promises": [
                "error",
                {
                    allowForKnownSafeCalls: [
                        {
                            from: "package",
                            name: ["describe", "it", "test", "suite"],
                            package: "node:test",
                        },
                    ],
                },
            ],

            // Object and type properties are left alone: results, plan schemas, events and CDP calls
            // have published or external field names.
            "@typescript-eslint/naming-convention": [
                "error",
                { selector: "default", format: null },
                { selector: ["function", "parameter", "variable"], format: ["camelCase"] },
                {
                    selector: "variable",
                    modifiers: ["const", "global"],
                    // PascalCase is for constant objects standing in for enums.
                    format: ["camelCase", "UPPER_CASE", "PascalCase"],
                },
                {
                    selector: ["parameter", "variable"],
                    types: ["boolean"],
                    format: ["PascalCase"],
                    prefix: ["is", "has", "can", "should", "was", "did"],
                },
                { selector: "classMethod", format: ["camelCase"] },
                {
                    selector: ["classProperty", "accessor"],
                    format: null,
                    leadingUnderscore: "forbid",
                },
                {
                    selector: "interface",
                    format: ["PascalCase"],
                    custom: { regex: `^I[A-Z]|${GENERIC_NAME_ENDINGS}`, match: false },
                },
                {
                    selector: ["class", "typeAlias"],
                    format: ["PascalCase"],
                    custom: { regex: GENERIC_NAME_ENDINGS, match: false },
                },
            ],
        },
    },
    {
        // Tests join when their sweep lands.
        files: ["packages/**/*.ts", "tools/**/*.ts"],
        rules: {
            curly: ["error", "all"],
            "@typescript-eslint/switch-exhaustiveness-check": "error",
        },
    },
    {
        files: ["packages/**/*.ts", "tools/**/*.ts"],
        // In-page functions can't import a constant, and their callbacks are left as written.
        ignores: IN_PAGE_FILES,
        rules: {
            "prefer-arrow-callback": "error",
            "no-restricted-syntax": ["error", ...everywhereSyntax, noExportStar, ...noMagicStrings],
        },
    },
    {
        files: ["packages/**/*.ts"],
        rules: {
            "revisum/in-page-functions-are-self-contained": [
                "error",
                { inPageFiles: IN_PAGE_FILES },
            ],
        },
    },
    {
        files: ["packages/*/src/index.ts"],
        rules: { "no-restricted-syntax": ["error", ...everywhereSyntax, ...noMagicStrings] },
    },
    {
        // A test file is one long describe callback, so function length says nothing about it.
        files: ["test/**/*.test.ts"],
        rules: {
            "max-lines-per-function": "off",
            "revisum/test-title-format": "error",
        },
    },
]);
