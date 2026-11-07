// An in-page function is sent to the browser as its source text and runs inside the page, so a name
// it borrows from its module type-checks but throws there. In-page functions are the top-level
// functions of the in-page files this rule is given; each may use only its own parameters and
// locals and the globals TypeScript's own libraries declare, those of the browser and of JavaScript.
// Node's globals, such as process, are not there. Every other file may send only a function
// declared in an in-page file, so no in-page function can live where this rule does not look.
import { relative, sep } from "node:path";
import {
    AST_NODE_TYPES,
    ESLintUtils,
    TSESLint,
    type ParserServicesWithTypeInformation,
    type TSESTree,
} from "@typescript-eslint/utils";
import ts from "typescript";

type Options = [{ readonly inPageFiles: readonly string[] }];
type MessageId = "borrowedName" | "sentFromElsewhere" | "writtenInPlace";
type FunctionNode =
    TSESTree.FunctionDeclaration | TSESTree.FunctionExpression | TSESTree.ArrowFunctionExpression;

// The type every driver method that runs a function in the page takes it as.
const PAGE_FUNCTION_TYPE = "PageFunction";
const WHERE_THE_FILES_ARE = "the files are listed in tools/eslint/eslint.config.js";

const repositoryPath = (cwd: string, file: string): string =>
    relative(cwd, file).split(sep).join("/");

const isFunctionNode = (node: TSESTree.Node | null | undefined): node is FunctionNode =>
    node?.type === AST_NODE_TYPES.FunctionDeclaration ||
    node?.type === AST_NODE_TYPES.FunctionExpression ||
    node?.type === AST_NODE_TYPES.ArrowFunctionExpression;

// The functions a module declares at its top level, exported or not.
function topLevelFunctions(program: TSESTree.Program): FunctionNode[] {
    const found: FunctionNode[] = [];
    for (const statement of program.body) {
        const declaration =
            statement.type === AST_NODE_TYPES.ExportNamedDeclaration
                ? statement.declaration
                : statement;
        if (declaration?.type === AST_NODE_TYPES.FunctionDeclaration) {
            found.push(declaration);
        } else if (declaration?.type === AST_NODE_TYPES.VariableDeclaration) {
            for (const declarator of declaration.declarations) {
                if (isFunctionNode(declarator.init)) {
                    found.push(declarator.init);
                }
            }
        }
    }
    return found;
}

// A function declaration's own name, which stays bound when its source runs as an expression.
const isOwnName = (fn: FunctionNode, variable: TSESLint.Scope.Variable): boolean =>
    fn.type === AST_NODE_TYPES.FunctionDeclaration &&
    variable.defs.some((definition) => definition.node === fn);

// A global that TypeScript's own libraries declare: the browser's or JavaScript's, never Node's.
function isLibraryGlobal(
    services: ParserServicesWithTypeInformation,
    identifier: TSESTree.Identifier,
): boolean {
    const symbol = services.program
        .getTypeChecker()
        .getSymbolAtLocation(services.esTreeNodeToTSNodeMap.get(identifier));
    // undefined and globalThis are built into the language, with no declaration at all.
    const declarations = symbol?.declarations ?? [];
    return (
        symbol !== undefined &&
        (declarations.length === 0 ||
            declarations.some((declaration) =>
                services.program.isSourceFileDefaultLibrary(declaration.getSourceFile()),
            ))
    );
}

// The names a function uses as values that it does not declare itself. A name in `typeof` within a
// type is erased with the type, so it never runs.
function borrowedNames(
    sourceCode: Readonly<TSESLint.SourceCode>,
    fn: FunctionNode,
): {
    readonly identifier: TSESTree.Identifier;
    readonly resolved: TSESLint.Scope.Variable | null;
}[] {
    return sourceCode
        .getScope(fn)
        .through.filter((reference) => reference.isValueReference)
        .flatMap(({ identifier, resolved }) =>
            identifier.type === AST_NODE_TYPES.Identifier &&
            !sourceCode
                .getAncestors(identifier)
                .some((ancestor) => ancestor.type === AST_NODE_TYPES.TSTypeQuery)
                ? [{ identifier, resolved }]
                : [],
        );
}

// The function a name stands for, followed through imports, or undefined when it is not one.
function declaredFunction(checker: ts.TypeChecker, node: ts.Node): ts.Declaration | undefined {
    const symbol = checker.getSymbolAtLocation(node);
    if (symbol === undefined) {
        return undefined;
    }
    const target =
        (symbol.flags & ts.SymbolFlags.Alias) === 0 ? symbol : checker.getAliasedSymbol(symbol);
    const declaration = target.declarations?.[0];
    if (declaration === undefined) {
        return undefined;
    }
    const isFunctionValue =
        ts.isFunctionDeclaration(declaration) ||
        (ts.isVariableDeclaration(declaration) &&
            declaration.initializer !== undefined &&
            (ts.isArrowFunction(declaration.initializer) ||
                ts.isFunctionExpression(declaration.initializer)));
    return isFunctionValue ? declaration : undefined;
}

// `name.toString()`, which is how a function's source is sent.
const sentByToString = (call: TSESTree.CallExpression): TSESTree.Identifier | undefined => {
    const { callee } = call;
    const isToString =
        callee.type === AST_NODE_TYPES.MemberExpression &&
        callee.property.type === AST_NODE_TYPES.Identifier &&
        callee.property.name === "toString" &&
        call.arguments.length === 0;
    return isToString && callee.object.type === AST_NODE_TYPES.Identifier
        ? callee.object
        : undefined;
};

export const inPageFunctionsAreSelfContained = ESLintUtils.RuleCreator.withoutDocs<
    Options,
    MessageId
>({
    meta: {
        type: "problem",
        schema: [
            {
                type: "object",
                properties: { inPageFiles: { type: "array", items: { type: "string" } } },
                required: ["inPageFiles"],
                additionalProperties: false,
            },
        ],
        messages: {
            borrowedName:
                "'{{name}}' does not exist in the page this in-page function runs in: use only its own parameters and locals and the browser's and JavaScript's globals, and pass anything else in as an argument.",
            sentFromElsewhere: `'{{name}}' is sent to run in the page, so declare it at the top level of an in-page file, where the in-page rule checks it (${WHERE_THE_FILES_ARE}).`,
            writtenInPlace: `This function is sent to run in the page: declare it at the top level of an in-page file, where the in-page rule checks it (${WHERE_THE_FILES_ARE}).`,
        },
    },
    defaultOptions: [{ inPageFiles: [] }],
    create(context, [{ inPageFiles }]) {
        const services = ESLintUtils.getParserServices(context);
        const checker = services.program.getTypeChecker();
        const isInPageFile = (file: string): boolean =>
            inPageFiles.includes(repositoryPath(context.cwd, file));

        const checkInPageFunction = (fn: FunctionNode): void => {
            for (const { identifier, resolved } of borrowedNames(context.sourceCode, fn)) {
                const isModuleBinding =
                    resolved !== null && resolved.scope.type !== TSESLint.Scope.ScopeType.global;
                const isAllowed = isModuleBinding
                    ? isOwnName(fn, resolved)
                    : isLibraryGlobal(services, identifier);
                if (!isAllowed) {
                    context.report({
                        node: identifier,
                        messageId: "borrowedName",
                        data: { name: identifier.name },
                    });
                }
            }
        };

        const checkSentFunction = (node: TSESTree.Identifier): void => {
            const declaration = declaredFunction(checker, services.esTreeNodeToTSNodeMap.get(node));
            if (declaration !== undefined && !isInPageFile(declaration.getSourceFile().fileName)) {
                context.report({ node, messageId: "sentFromElsewhere", data: { name: node.name } });
            }
        };

        const isPageFunctionArgument = (argument: TSESTree.Node): boolean => {
            const expression = services.esTreeNodeToTSNodeMap.get(argument);
            return (
                ts.isExpression(expression) &&
                checker.getContextualType(expression)?.aliasSymbol?.name === PAGE_FUNCTION_TYPE
            );
        };

        return {
            Program(program) {
                if (isInPageFile(context.filename)) {
                    topLevelFunctions(program).forEach(checkInPageFunction);
                }
            },
            CallExpression(call) {
                const sent = sentByToString(call);
                if (sent !== undefined) {
                    checkSentFunction(sent);
                }
                for (const argument of call.arguments) {
                    if (
                        argument.type === AST_NODE_TYPES.Identifier &&
                        isPageFunctionArgument(argument)
                    ) {
                        checkSentFunction(argument);
                    } else if (isFunctionNode(argument) && isPageFunctionArgument(argument)) {
                        context.report({ node: argument, messageId: "writtenInPlace" });
                    }
                }
            },
        };
    },
});
