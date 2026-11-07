// An in-page function is sent to the browser as its source text and runs inside the page, so a name
// it borrows from its module type-checks but throws there. In-page functions are the top-level
// functions of the in-page files this rule is given; each may use only its own parameters and
// locals and the globals TypeScript's own libraries declare, those of the browser and of JavaScript.
// Node's globals, such as process, are not there. Every function sent by `toString()` or as a
// PageFunction argument must be a top-level function of an in-page file, so no function sent that
// way can live where this rule does not look. An in-page file may not keep functions in top-level
// objects or classes either: a method's source does not run on its own. Page code written as a
// string, not as a function, is outside what this rule can see.
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
type MessageId = "borrowedName" | "functionInObject" | "sentFromElsewhere" | "writtenInPlace";
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

// The functions a top-level object literal or class holds, at any depth.
function functionsInObjects(program: TSESTree.Program): TSESTree.Node[] {
    const found: TSESTree.Node[] = [];
    const visit = (node: TSESTree.Node | null | undefined): void => {
        if (node?.type === AST_NODE_TYPES.ObjectExpression) {
            for (const property of node.properties) {
                if (property.type === AST_NODE_TYPES.Property) {
                    if (isFunctionNode(property.value)) {
                        found.push(property);
                    } else {
                        visit(property.value);
                    }
                }
            }
        } else if (node?.type === AST_NODE_TYPES.ArrayExpression) {
            node.elements.forEach(visit);
        } else if (
            node?.type === AST_NODE_TYPES.ClassDeclaration ||
            node?.type === AST_NODE_TYPES.ClassExpression
        ) {
            found.push(
                ...node.body.body.filter(
                    (member) =>
                        member.type === AST_NODE_TYPES.MethodDefinition ||
                        (member.type === AST_NODE_TYPES.PropertyDefinition &&
                            isFunctionNode(member.value)),
                ),
            );
        }
    };
    for (const statement of program.body) {
        const declaration =
            statement.type === AST_NODE_TYPES.ExportNamedDeclaration
                ? statement.declaration
                : statement;
        if (declaration?.type === AST_NODE_TYPES.VariableDeclaration) {
            declaration.declarations.forEach((declarator) => {
                visit(declarator.init);
            });
        } else {
            visit(declaration);
        }
    }
    return found;
}

// An expression without its parentheses and type assertions, which change nothing at run time.
function unwrapped(node: ts.Expression): ts.Expression {
    if (
        ts.isParenthesizedExpression(node) ||
        ts.isAsExpression(node) ||
        ts.isSatisfiesExpression(node) ||
        ts.isNonNullExpression(node) ||
        ts.isTypeAssertionExpression(node)
    ) {
        return unwrapped(node.expression);
    }
    return node;
}

// The declarations a sent expression's value may come from, followed through imports and both
// branches of a condition; undefined for any the type checker cannot name.
function sentDeclarations(
    checker: ts.TypeChecker,
    sent: ts.Expression,
): readonly (ts.Declaration | undefined)[] {
    const expression = unwrapped(sent);
    if (ts.isConditionalExpression(expression)) {
        return [
            ...sentDeclarations(checker, expression.whenTrue),
            ...sentDeclarations(checker, expression.whenFalse),
        ];
    }
    const named = ts.isPropertyAccessExpression(expression) ? expression.name : expression;
    const symbol =
        checker.getSymbolAtLocation(named) ?? checker.getTypeAtLocation(expression).getSymbol();
    if (symbol === undefined) {
        return [undefined];
    }
    const target =
        (symbol.flags & ts.SymbolFlags.Alias) === 0 ? symbol : checker.getAliasedSymbol(symbol);
    return [target.declarations?.[0]];
}

const isFunctionExpression = (node: ts.Node | undefined): boolean =>
    node !== undefined && (ts.isArrowFunction(node) || ts.isFunctionExpression(node));

// A declaration that holds a function of its own, rather than one handed to it from elsewhere, as a
// parameter or a field typed as a page function is.
const holdsItsOwnFunction = (declaration: ts.Declaration): boolean =>
    ts.isFunctionDeclaration(declaration) ||
    ts.isMethodDeclaration(declaration) ||
    isFunctionExpression(declaration) ||
    ((ts.isVariableDeclaration(declaration) ||
        ts.isPropertyAssignment(declaration) ||
        ts.isPropertyDeclaration(declaration)) &&
        isFunctionExpression(declaration.initializer));

// A function declared at the top level of its module, by name or as a constant.
const isTopLevelFunction = (declaration: ts.Declaration): boolean =>
    (ts.isFunctionDeclaration(declaration) && ts.isSourceFile(declaration.parent)) ||
    (ts.isVariableDeclaration(declaration) &&
        isFunctionExpression(declaration.initializer) &&
        ts.isVariableStatement(declaration.parent.parent) &&
        ts.isSourceFile(declaration.parent.parent.parent));

// `expression.toString()`, which is how a function's source is sent.
const sentByToString = (call: TSESTree.CallExpression): TSESTree.Expression | undefined => {
    const { callee } = call;
    return callee.type === AST_NODE_TYPES.MemberExpression &&
        callee.property.type === AST_NODE_TYPES.Identifier &&
        callee.property.name === "toString" &&
        call.arguments.length === 0
        ? callee.object
        : undefined;
};

const isFunctionValue = (
    services: ParserServicesWithTypeInformation,
    node: TSESTree.Node,
): boolean =>
    services.program
        .getTypeChecker()
        .getTypeAtLocation(services.esTreeNodeToTSNodeMap.get(node))
        .getCallSignatures().length > 0;

// An argument the called function takes as a PageFunction, which it runs in the page.
function isTypedAsPageFunction(
    services: ParserServicesWithTypeInformation,
    argument: TSESTree.Node,
): boolean {
    const expression = services.esTreeNodeToTSNodeMap.get(argument);
    return (
        ts.isExpression(expression) &&
        services.program.getTypeChecker().getContextualType(expression)?.aliasSymbol?.name ===
            PAGE_FUNCTION_TYPE
    );
}

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
            functionInObject:
                "An in-page file keeps each function at its top level, where the in-page rule checks it: a method's source does not run on its own when sent to the page.",
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

        // A sent value must come from a top-level function of an in-page file. One handed in from
        // elsewhere, as a parameter or a typed field, was checked where it was first sent.
        const checkSentFunction = (node: TSESTree.Expression): void => {
            const sent = services.esTreeNodeToTSNodeMap.get(node);
            const declarations = ts.isExpression(sent)
                ? sentDeclarations(checker, sent)
                : [undefined];
            const isSentFromInPageFile = declarations.every(
                (declaration) =>
                    declaration !== undefined &&
                    (!holdsItsOwnFunction(declaration) ||
                        (isTopLevelFunction(declaration) &&
                            isInPageFile(declaration.getSourceFile().fileName))),
            );
            if (!isSentFromInPageFile) {
                context.report({
                    node,
                    messageId: "sentFromElsewhere",
                    data: { name: context.sourceCode.getText(node) },
                });
            }
        };

        const isPageFunctionArgument = (argument: TSESTree.Node): boolean =>
            isTypedAsPageFunction(services, argument);

        return {
            Program(program) {
                if (isInPageFile(context.filename)) {
                    topLevelFunctions(program).forEach(checkInPageFunction);
                    for (const node of functionsInObjects(program)) {
                        context.report({ node, messageId: "functionInObject" });
                    }
                }
            },
            CallExpression(call) {
                const sent = sentByToString(call);
                if (sent !== undefined && isFunctionValue(services, sent)) {
                    checkSentFunction(sent);
                }
                for (const argument of call.arguments) {
                    if (argument.type === AST_NODE_TYPES.SpreadElement) {
                        continue;
                    }
                    if (isFunctionNode(argument) && isPageFunctionArgument(argument)) {
                        context.report({ node: argument, messageId: "writtenInPlace" });
                    } else if (isPageFunctionArgument(argument)) {
                        checkSentFunction(argument);
                    }
                }
            },
        };
    },
});
