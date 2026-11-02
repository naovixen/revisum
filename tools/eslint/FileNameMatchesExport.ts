// Source files are PascalCase and named after an export they hold, so a symbol and its file can be
// found from each other. Closely related exports may share the file. Folders are kebab-case.
import { relative, sep } from "node:path";
import type { Rule } from "eslint";
import type { Program } from "estree";

const KEBAB_FOLDER = /^[a-z0-9]+(-[a-z0-9]+)*$/;
const SOURCE_FILE = /^[A-Z][A-Za-z0-9]*\.ts$/;
const TEST_FILE = /^[A-Z][A-Za-z0-9]*(\.[A-Z][A-Za-z0-9]*)?\.test\.ts$/;

function toPascalCase(exportName: string): string {
    const isConstantCase = exportName === exportName.toUpperCase();
    return exportName
        .split("_")
        .filter((word) => word !== "")
        .map((word) => {
            const rest = isConstantCase ? word.slice(1).toLowerCase() : word.slice(1);
            return word.charAt(0).toUpperCase() + rest;
        })
        .join("");
}

// The names a file exports, or null when `export *` means they can't be read from this file alone.
function exportedNames(program: Program): readonly string[] | null {
    const names: string[] = [];
    for (const statement of program.body) {
        if (statement.type === "ExportAllDeclaration") {
            return null;
        }
        if (statement.type !== "ExportNamedDeclaration") {
            continue;
        }
        for (const specifier of statement.specifiers) {
            if (specifier.exported.type === "Identifier") {
                names.push(specifier.exported.name);
            }
        }
        names.push(...declaredNames(statement.declaration));
    }
    return names;
}

// The parser adds TypeScript declarations that ESTree's types don't list, so `id` is read by shape.
function declaredNames(declaration: unknown): readonly string[] {
    if (typeof declaration !== "object" || declaration === null) {
        return [];
    }
    if ("declarations" in declaration && Array.isArray(declaration.declarations)) {
        return declaration.declarations.flatMap((declarator: unknown) =>
            typeof declarator === "object" && declarator !== null && "id" in declarator
                ? identifierName(declarator.id)
                : [],
        );
    }
    return "id" in declaration ? identifierName(declaration.id) : [];
}

function identifierName(node: unknown): readonly string[] {
    const isIdentifier =
        typeof node === "object" && node !== null && "type" in node && node.type === "Identifier";
    return isIdentifier && "name" in node && typeof node.name === "string" ? [node.name] : [];
}

export const fileNameMatchesExport: Rule.RuleModule = {
    meta: {
        type: "suggestion",
        docs: {
            description: "Name files in PascalCase after an export, and folders in kebab-case",
        },
        schema: [],
        messages: {
            fileNameCase:
                "Name this file in PascalCase with no type suffix: PlanParser.ts, or PlanParser.test.ts and PlanParser.Errors.test.ts for tests.",
            folderCase: "Name the folder '{{folder}}' in kebab-case.",
            noMatchingExport:
                "Name this file after its main export ('{{expected}}' doesn't match any), or move the exports to a file that does.",
        },
    },
    create(context) {
        return {
            Program(node) {
                const parts = relative(context.cwd, context.filename).split(sep);
                const fileName = parts.at(-1) ?? "";

                for (const folder of parts.slice(0, -1)) {
                    if (!KEBAB_FOLDER.test(folder)) {
                        context.report({ node, messageId: "folderCase", data: { folder } });
                    }
                }
                if (fileName === "index.ts") {
                    return;
                }
                if (fileName.endsWith(".test.ts")) {
                    if (!TEST_FILE.test(fileName)) {
                        context.report({ node, messageId: "fileNameCase" });
                    }
                    return;
                }
                if (!SOURCE_FILE.test(fileName)) {
                    context.report({ node, messageId: "fileNameCase" });
                    return;
                }

                const names = exportedNames(node);
                const expected = fileName.slice(0, -".ts".length);
                if (
                    names !== null &&
                    names.length > 0 &&
                    !names.map(toPascalCase).includes(expected)
                ) {
                    context.report({ node, messageId: "noMatchingExport", data: { expected } });
                }
            },
        };
    },
};
