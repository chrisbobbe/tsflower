import ts from "typescript";
import { builders as b, namedTypes as n } from "ast-types";
import K from "ast-types/gen/kinds";
import { map, some } from "./util";
import { Mapper, MapResultType } from "./mapper";
import { hasModifier, isEntityNameOrEntityNameExpression } from "./tsutil";

export type ErrorDescription = {
  kind: "unimplemented" | "error";
  description: string;
};

export const mkError = (description: string): ErrorDescription => ({
  kind: "error",
  description,
});

export const mkUnimplemented = (description: string): ErrorDescription => ({
  kind: "unimplemented",
  description,
});

export type ErrorOr<T> = { kind: "success"; result: T } | ErrorDescription;

export const mkSuccess = <T>(result: T): ErrorOr<T> => ({
  kind: "success",
  result,
});

export interface Converter {
  convertType(node: ts.TypeNode): K.FlowTypeKind;
  errorType(node: ts.TypeNode, description: string): K.FlowTypeKind;
  unimplementedType(node: ts.TypeNode, description: string): K.FlowTypeKind;
  crudeError(node: ts.Node): never;
}

const headerComment = ` ${"@"}flow
 * ${"@"}generated by TsFlower
 `;

export function convertSourceFile(
  sourceFile: ts.SourceFile,
  mapper: Mapper,
  program: ts.Program
): n.File {
  const checker = program.getTypeChecker();

  const converter: Converter = {
    convertType,
    errorType,
    unimplementedType,
    crudeError,
  };

  return b.file(
    b.program.from({
      comments: [b.commentBlock(headerComment)],
      body: sourceFile.statements.map(convertStatement),
    }),
    sourceFile.fileName
  );

  function convertStatement(node: ts.Statement): K.StatementKind {
    try {
      const inner = convertStatementExceptExport(node);

      if (hasModifier(node, ts.SyntaxKind.ExportKeyword)) {
        return modifyStatementAsExport(inner, node);
      }

      return inner;
    } catch (err) {
      console.error(err);
      return errorStatement(node, `internal error: ${(err as Error).message}`);
    }
  }

  function modifyStatementAsExport(
    inner: K.StatementKind,
    node: ts.Statement
  ): K.StatementKind {
    if (n.DeclareFunction.check(inner) || n.DeclareClass.check(inner)) {
      // TODO are there more cases that should go this way?
      return b.declareExportDeclaration(
        hasModifier(node, ts.SyntaxKind.DefaultKeyword),
        inner
      );
    } else if (n.DeclareInterface.check(inner)) {
      // Awkwardly convert a DeclareInterface to an InterfaceDeclaration.
      // This causes recast to correctly emit `export interface`
      // instead of `export declare interface`, which Flow rejects.
      return b.exportNamedDeclaration(
        b.interfaceDeclaration.from({
          id: inner.id,
          typeParameters: inner.typeParameters,
          extends: inner.extends,
          body: inner.body,
        })
      );
    } else if (n.Declaration.check(inner)) {
      // The generic case.
      return b.exportNamedDeclaration(inner as K.DeclarationKind);
    } else if (n.EmptyStatement.check(inner)) {
      // Presumably an error or unimplemented.  Nothing further to log.
      return inner;
    } else {
      return warningStatement(
        inner,
        node,
        `statement has "export", but conversion not a declaration`
      );
    }
  }

  function convertStatementExceptExport(node: ts.Statement): K.StatementKind {
    switch (node.kind) {
      case ts.SyntaxKind.ImportDeclaration:
        return convertImportDeclaration(node as ts.ImportDeclaration);

      case ts.SyntaxKind.ExportDeclaration:
        return convertExportDeclaration(node as ts.ExportDeclaration);

      case ts.SyntaxKind.ExportAssignment:
        return convertExportAssignment(node as ts.ExportAssignment);

      case ts.SyntaxKind.VariableStatement:
        return convertVariableStatement(node as ts.VariableStatement);

      case ts.SyntaxKind.TypeAliasDeclaration:
        return convertTypeAliasDeclaration(node as ts.TypeAliasDeclaration);

      case ts.SyntaxKind.FunctionDeclaration:
        return convertFunctionDeclaration(node as ts.FunctionDeclaration);

      case ts.SyntaxKind.ClassDeclaration:
      case ts.SyntaxKind.InterfaceDeclaration:
        return convertClassLikeDeclaration(
          node as ts.ClassDeclaration | ts.InterfaceDeclaration
        );

      case ts.SyntaxKind.Block:
      case ts.SyntaxKind.EmptyStatement:
      case ts.SyntaxKind.EnumDeclaration:
      case ts.SyntaxKind.ModuleDeclaration:
      case ts.SyntaxKind.NamespaceExportDeclaration:
      case ts.SyntaxKind.ImportEqualsDeclaration:
      case ts.SyntaxKind.MissingDeclaration:
        // These statements might actually appear in .d.ts files.
        return unimplementedStatement(node, ts.SyntaxKind[node.kind]);

      case ts.SyntaxKind.ExpressionStatement:
      case ts.SyntaxKind.IfStatement:
      case ts.SyntaxKind.DoStatement:
      case ts.SyntaxKind.WhileStatement:
      case ts.SyntaxKind.ForStatement:
      case ts.SyntaxKind.ForInStatement:
      case ts.SyntaxKind.ForOfStatement:
      case ts.SyntaxKind.ContinueStatement:
      case ts.SyntaxKind.BreakStatement:
      case ts.SyntaxKind.ReturnStatement:
      case ts.SyntaxKind.WithStatement:
      case ts.SyntaxKind.SwitchStatement:
      case ts.SyntaxKind.LabeledStatement:
      case ts.SyntaxKind.ThrowStatement:
      case ts.SyntaxKind.TryStatement:
      case ts.SyntaxKind.DebuggerStatement:
      case ts.SyntaxKind.CaseBlock:
        // These shouldn't appear in .d.ts files.  So they shouldn't come up
        // unless we try to handle normal source files.
        return unimplementedStatement(node, ts.SyntaxKind[node.kind]);

      case ts.SyntaxKind.VariableDeclaration:
      case ts.SyntaxKind.VariableDeclarationList:
      case ts.SyntaxKind.ModuleBlock:
      case ts.SyntaxKind.ImportClause:
      case ts.SyntaxKind.NamespaceImport:
      case ts.SyntaxKind.NamedImports:
      case ts.SyntaxKind.ImportSpecifier:
      case ts.SyntaxKind.NamedExports:
      case ts.SyntaxKind.NamespaceExport:
      case ts.SyntaxKind.ExportSpecifier:
        // Not actually statements -- pieces of statements.  We'll handle
        // these below, as part of handling the statements they appear in.
        return errorStatement(
          node,
          `unexpected statement kind: ${ts.SyntaxKind[node.kind]}`
        );

      default:
        return errorStatement(
          node,
          `unexpected statement kind: ${ts.SyntaxKind[node.kind]}`
        );
    }
  }

  function convertImportDeclaration(
    node: ts.ImportDeclaration
  ): K.StatementKind {
    const { importClause } = node;
    if (!importClause)
      return unimplementedStatement(
        node,
        "ImportDeclaration with no import clause"
      );

    if (importClause.modifiers)
      return unimplementedStatement(node, `ImportDeclaration with modifiers`);

    const specifiers: (
      | n.ImportSpecifier
      | n.ImportNamespaceSpecifier
      | n.ImportDefaultSpecifier
    )[] = [];

    if (importClause.name)
      specifiers.push(
        b.importDefaultSpecifier(convertIdentifier(importClause.name))
      );

    const { namedBindings } = importClause;
    if (namedBindings) {
      if (ts.isNamedImports(namedBindings)) {
        for (const binding of namedBindings.elements) {
          const localSymbol = checker.getSymbolAtLocation(binding.name);
          const importedSymbol =
            localSymbol && checker.getImmediateAliasedSymbol(localSymbol);
          // If the symbol is declared only as a type, not a value, then in
          // Flow we need to say "type" on the import.  (It might have both:
          // for example, both an interface and class declaration, like
          // React.Component does.)
          const isTypeOnly =
            importedSymbol && !(importedSymbol.flags & ts.SymbolFlags.Value);

          specifiers.push(
            b.importSpecifier.from({
              imported: convertIdentifier(binding.propertyName ?? binding.name),
              local: convertIdentifier(binding.name),
              // TODO: use modifier on this ts.ImportSpecifier, if present.
              importKind: isTypeOnly ? "type" : "value",
            })
          );
        }
      } else {
        specifiers.push(
          b.importNamespaceSpecifier(convertIdentifier(namedBindings.name))
        );
      }
    }

    const source = b.stringLiteral(
      // JSDoc on ImportDeclaration#moduleSpecifier says:
      //   > If this is not a StringLiteral it will be a grammar error.
      (node.moduleSpecifier as ts.StringLiteral).text
    );

    return b.importDeclaration(specifiers, source);
  }

  function convertExportDeclaration(
    node: ts.ExportDeclaration
  ): K.StatementKind {
    const { isTypeOnly, exportClause, moduleSpecifier, assertClause } = node;

    if (assertClause) {
      return unimplementedStatement(node, "`export … from 'foo' assert { … }`");
    }

    const source = !moduleSpecifier
      ? null
      : // Quoth ExportDeclaration jsdoc: "If this is not a StringLiteral it will be a grammar error."
        b.stringLiteral((moduleSpecifier as ts.StringLiteral).text);

    if (!exportClause) {
      if (!source)
        return errorStatement(node, "expected `export *` to have `from`");
      return b.exportAllDeclaration(source, null);
    } else if (ts.isNamespaceExport(exportClause)) {
      return b.exportNamedDeclaration(
        null,
        // @ts-expect-error TODO get ast-types and recast to handle this
        [b.exportNamespaceSpecifier(convertIdentifier(exportClause.name))],
        source
      );
    } else if (ts.isNamedExports(exportClause)) {
      const specifiers = [];
      for (const spec of exportClause.elements) {
        const { isTypeOnly: specIsTypeOnly, propertyName, name } = spec;
        specifiers.push(
          b.exportSpecifier.from({
            local: convertIdentifier(propertyName ?? name),
            exported: convertIdentifier(name),
            // @ts-expect-error TODO(wrong) get ast-types and recast to handle this
            exportKind: specIsTypeOnly ? "type" : "value",
          })
        );
      }
      return b.exportNamedDeclaration.from({
        declaration: null,
        specifiers,
        source,
        // @ts-expect-error TODO(wrong) get ast-types and recast to handle this
        exportKind: isTypeOnly ? "type" : "value",
      });
    } else {
      ((_: never) => {})(exportClause);
      return errorStatement(
        node,
        // @ts-expect-error yes, the types say this is unreachable
        `unexpected export clause: ${ts.SyntaxKind[exportClause.kind]}`
      );
    }
  }

  function convertExportAssignment(node: ts.ExportAssignment): K.StatementKind {
    if (node.isExportEquals) {
      return unimplementedStatement(node, '"export ="');
    }

    if (!ts.isIdentifier(node.expression))
      // TODO(runtime): These don't appear in .d.ts files, but do in TS.
      return unimplementedStatement(
        node,
        `"export default" with non-identifier`
      );

    return b.exportDefaultDeclaration(convertIdentifier(node.expression));
  }

  function convertVariableStatement(
    node: ts.VariableStatement
  ): K.StatementKind {
    const flags =
      node.declarationList.flags & (ts.NodeFlags.Const | ts.NodeFlags.Let);
    return b.variableDeclaration(
      flags === ts.NodeFlags.Const
        ? "var" // TODO(runtime): For .js.flow files, we always declare `var`, not `const`.
        : flags === ts.NodeFlags.Let
        ? "let"
        : "var",
      map(node.declarationList.declarations, (node) => {
        return b.variableDeclarator(
          convertIdentifier(
            node.name /* TODO */ as ts.Identifier,
            node.type && convertType(node.type)
          )
        );
      })
    );
  }

  function convertTypeAliasDeclaration(
    node: ts.TypeAliasDeclaration
  ): K.StatementKind {
    return b.typeAlias(
      convertIdentifier(node.name),
      convertTypeParameterDeclaration(node.typeParameters),
      convertType(node.type)
    );
  }

  function convertFunctionDeclaration(node: ts.FunctionDeclaration) {
    if (!node.name) {
      if (
        hasModifier(node, ts.SyntaxKind.ExportKeyword) &&
        hasModifier(node, ts.SyntaxKind.DefaultKeyword)
      ) {
        // TS accepts this, and then puts it in `.d.ts` files.  But there
        // doesn't seem to be a Flow equivalent if you say `declare`; and if
        // you don't, then implementations are required.  Probably the
        // solution is we should generate a fresh name.
        return unimplementedStatement(
          node,
          "`export default function` with no name"
        );
      }

      // I believe this is not valid TS.
      return errorStatement(node, "expected name on FunctionDeclaration");
    }

    return b.declareFunction(
      convertIdentifier(node.name, convertFunctionType(node))
    );
  }

  function convertClassLikeDeclaration(
    node: ts.ClassDeclaration | ts.InterfaceDeclaration
  ) {
    if (!node.name) {
      if (
        hasModifier(node, ts.SyntaxKind.ExportKeyword) &&
        hasModifier(node, ts.SyntaxKind.DefaultKeyword)
      ) {
        // TS accepts this, and then puts it in `.d.ts` files.  But there
        // doesn't seem to be a Flow equivalent if you say `declare`; and if
        // you don't, then implementations are required.  Probably the
        // solution is we should generate a fresh name.
        return unimplementedStatement(
          node,
          "`export default class` with no name"
        );
      }

      // I believe this is not valid TS.
      return errorStatement(node, "anonymous class not in `export default`");
    }

    const typeParameters = convertTypeParameterDeclaration(node.typeParameters);

    const extends_: n.InterfaceExtends[] = [];
    for (const heritageClause of node.heritageClauses ?? []) {
      const { token, types } = heritageClause;
      if (token === ts.SyntaxKind.ExtendsKeyword) {
        for (const base of types) {
          const { expression, typeArguments } = base;
          if (
            !ts.isIdentifier(expression) &&
            !ts.isPropertyAccessExpression(expression)
          ) {
            return errorStatement(
              node,
              `unexpected 'extends' base kind: ${
                ts.SyntaxKind[expression.kind]
              }`
            );
          }
          if (!isEntityNameOrEntityNameExpression(expression))
            return errorStatement(node, `'extends' not an entity name`);

          extends_.push(
            b.interfaceExtends.from({
              id: convertEntityNameAsType(expression),
              typeParameters: convertTypeArguments(expression, typeArguments),
            })
          );
        }
      } else {
        return unimplementedStatement(node, `class 'implements'`);
      }
    }

    const properties: (
      | n.ObjectTypeProperty
      | n.ObjectTypeSpreadProperty
    )[] = [];
    const indexers: n.ObjectTypeIndexer[] | undefined = []; // TODO
    const callProperties: n.ObjectTypeCallProperty[] | undefined = []; // TODO
    for (const member of node.members) {
      switch (member.kind) {
        case ts.SyntaxKind.Constructor:
          properties.push(
            // TODO: return type should be void, not any
            b.objectTypeProperty(
              b.identifier("constructor"),
              convertFunctionType(member as ts.ConstructorDeclaration),
              false
            )
          );
          break;

        case ts.SyntaxKind.PropertySignature:
        case ts.SyntaxKind.PropertyDeclaration: {
          const {
            name,
            questionToken,
            type,
          } = member as ts.PropertyDeclaration;

          const key = convertName(name);
          if (!key) continue;

          properties.push(
            b.objectTypeProperty(
              key,
              type ? convertType(type) : b.anyTypeAnnotation(),
              !!questionToken
            )
          );
          break;
        }

        case ts.SyntaxKind.MethodSignature:
        case ts.SyntaxKind.MethodDeclaration: {
          const { name, questionToken } = member as ts.MethodDeclaration;

          const key = convertName(name);
          if (!key) continue;

          properties.push(
            b.objectTypeProperty(
              key,
              convertFunctionType(member as ts.MethodDeclaration),
              !!questionToken
            )
          );
          break;
        }

        case ts.SyntaxKind.CallSignature:
        case ts.SyntaxKind.ConstructSignature:
        case ts.SyntaxKind.SemicolonClassElement:
        case ts.SyntaxKind.GetAccessor:
        case ts.SyntaxKind.SetAccessor:
        case ts.SyntaxKind.IndexSignature:
        case ts.SyntaxKind.ClassStaticBlockDeclaration:
          return unimplementedStatement(
            node,
            `ClassElement|TypeElement kind: ${ts.SyntaxKind[member.kind]}`
          );

        default:
          return errorStatement(
            node,
            `unexpected ClassElement|TypeElement kind: ${
              ts.SyntaxKind[member.kind]
            }`
          );
      }
    }

    const params = {
      id: convertIdentifier(node.name),
      typeParameters,
      extends: extends_,
      body: b.objectTypeAnnotation(properties, indexers, callProperties),
    };

    if (ts.isInterfaceDeclaration(node)) {
      return b.declareInterface.from(params);
    } else {
      return b.declareClass.from(params);
    }

    function convertName(
      node: ts.PropertyName
    ): null | K.IdentifierKind | K.LiteralKind {
      if (ts.isIdentifier(node)) {
        return convertIdentifier(node);
      } else if (ts.isPrivateIdentifier(node)) {
        // A private property in `declare class` is useless, because it
        // can't be referred to by anything using the declaration.
        // (Private properties can only be referred to within the class
        // definition.)  TS allows them, but Flow doesn't; just drop it
        // from the output.
        // TODO(runtime): Handle private properties.
        return null;
      } else {
        // TODO
        throw new Error(
          `unimplemented: PropertyName kind ${ts.SyntaxKind[node.kind]}`
        );
      }
    }
  }

  function convertType(node: ts.TypeNode): K.FlowTypeKind {
    switch (node.kind) {
      case ts.SyntaxKind.UnknownKeyword:
        return b.mixedTypeAnnotation();
      case ts.SyntaxKind.AnyKeyword:
        return b.anyTypeAnnotation();
      case ts.SyntaxKind.NeverKeyword:
        return b.emptyTypeAnnotation();

      case ts.SyntaxKind.UndefinedKeyword:
      case ts.SyntaxKind.VoidKeyword:
        return b.voidTypeAnnotation();
      case ts.SyntaxKind.BooleanKeyword:
        return b.booleanTypeAnnotation();
      case ts.SyntaxKind.NumberKeyword:
        return b.numberTypeAnnotation();
      case ts.SyntaxKind.StringKeyword:
        return b.stringTypeAnnotation();
      case ts.SyntaxKind.ObjectKeyword:
        return b.objectTypeAnnotation.from({ properties: [], inexact: true });

      case ts.SyntaxKind.ThisType:
        return b.thisTypeAnnotation();

      case ts.SyntaxKind.ParenthesizedType:
        // TODO: Am I missing something?
        return convertType((node as ts.ParenthesizedTypeNode).type);

      case ts.SyntaxKind.LiteralType:
        return convertLiteralType(node as ts.LiteralTypeNode);

      case ts.SyntaxKind.TypeQuery: {
        const { exprName } = node as ts.TypeQueryNode;
        return b.typeofTypeAnnotation(
          b.genericTypeAnnotation(convertEntityNameAsType(exprName), null)
        );
      }

      case ts.SyntaxKind.TypeOperator:
        return convertTypeOperator(node as ts.TypeOperatorNode);

      case ts.SyntaxKind.TypeReference:
        return convertTypeReference(node as ts.TypeReferenceNode);

      case ts.SyntaxKind.UnionType:
        return convertUnionType(node as ts.UnionTypeNode);

      case ts.SyntaxKind.IntersectionType: {
        const { types } = node as ts.IntersectionTypeNode;
        return b.intersectionTypeAnnotation(types.map(convertType));
      }

      case ts.SyntaxKind.IndexedAccessType:
        return b.genericTypeAnnotation(
          // TODO(flow-155): Switch to Flow indexed-access-type syntax.
          b.identifier("$ElementType"),
          b.typeParameterInstantiation([
            convertType((node as ts.IndexedAccessTypeNode).objectType),
            convertType((node as ts.IndexedAccessTypeNode).indexType),
          ])
        );

      case ts.SyntaxKind.ArrayType:
        return b.arrayTypeAnnotation(
          convertType((node as ts.ArrayTypeNode).elementType)
        );

      case ts.SyntaxKind.TupleType:
        return b.tupleTypeAnnotation(
          (node as ts.TupleTypeNode).elements.map(convertType)
        );

      case ts.SyntaxKind.FunctionType:
        return convertFunctionType(node as ts.FunctionTypeNode);

      case ts.SyntaxKind.TypeLiteral:
        return convertTypeLiteral(node as ts.TypeLiteralNode);

      case ts.SyntaxKind.TypePredicate:
      case ts.SyntaxKind.ConstructorType:
      case ts.SyntaxKind.OptionalType:
      case ts.SyntaxKind.RestType:
      case ts.SyntaxKind.ConditionalType:
      case ts.SyntaxKind.InferType:
      case ts.SyntaxKind.MappedType:
      case ts.SyntaxKind.LiteralType:
      case ts.SyntaxKind.TemplateLiteralType:
      case ts.SyntaxKind.TemplateLiteralTypeSpan:
      case ts.SyntaxKind.ImportType:
        return unimplementedType(node, ts.SyntaxKind[node.kind]);

      case ts.SyntaxKind.NamedTupleMember:
        // Not actually types -- pieces of types.
        return errorType(
          node,
          `unexpected type kind: ${ts.SyntaxKind[node.kind]}`
        );

      default:
        return errorType(
          node,
          `unexpected type kind: ${ts.SyntaxKind[node.kind]}`
        );
    }
  }

  function convertLiteralType(node: ts.LiteralTypeNode): K.FlowTypeKind {
    switch (node.literal.kind) {
      case ts.SyntaxKind.NullKeyword:
        return b.nullTypeAnnotation();
      case ts.SyntaxKind.FalseKeyword:
        return b.booleanLiteralTypeAnnotation(false, "false");
      case ts.SyntaxKind.TrueKeyword:
        return b.booleanLiteralTypeAnnotation(true, "true");

      case ts.SyntaxKind.PrefixUnaryExpression: {
        const literal = node.literal as ts.PrefixUnaryExpression;
        if (literal.operator !== ts.SyntaxKind.MinusToken)
          return errorType(
            node,
            `LiteralTypeNode with PrefixUnaryExpression operator ${
              ts.SyntaxKind[literal.operator]
            }; expected MinusToken`
          );
        if (!ts.isNumericLiteral(literal.operand))
          return errorType(
            node,
            `LiteralTypeNode with unary-minus of ${
              ts.SyntaxKind[literal.operand.kind]
            }; expected NumericLiteral`
          );
        const { text } = literal.operand;
        // TODO: is more conversion needed on these number literals?
        return b.numberLiteralTypeAnnotation(-Number(text), text);
      }

      case ts.SyntaxKind.NumericLiteral: {
        const { text } = node.literal;
        // TODO: is more conversion needed on these number literals?
        return b.numberLiteralTypeAnnotation(Number(text), text);
      }

      case ts.SyntaxKind.StringLiteral: {
        const { text } = node.literal;
        // TODO: is more conversion needed on these string literals?
        return b.stringLiteralTypeAnnotation(text, text);
      }

      case ts.SyntaxKind.BigIntLiteral: // TODO is this possible?
      default:
        return errorType(
          node,
          `unexpected literal-type kind: ${ts.SyntaxKind[node.literal.kind]}`
        );
    }
  }

  function convertTypeOperator(node: ts.TypeOperatorNode): K.FlowTypeKind {
    const { operator, type } = node;
    switch (operator) {
      case ts.SyntaxKind.KeyOfKeyword:
        return b.genericTypeAnnotation(
          b.identifier("$Keys"),
          b.typeParameterInstantiation([convertType(type)])
        );

      case ts.SyntaxKind.UniqueKeyword:
      case ts.SyntaxKind.ReadonlyKeyword:
        return unimplementedType(
          node,
          `type operator: ${ts.SyntaxKind[operator]}`
        );

      default:
        return errorType(
          node,
          `unexpected type operator: ${ts.SyntaxKind[operator]}`
        );
    }
  }

  function convertTypeReference(node: ts.TypeReferenceNode): K.FlowTypeKind {
    const result = convertTypeReferenceLike(node.typeName, node.typeArguments);
    if (result.kind !== "success")
      return result.kind === "error"
        ? errorType(node, result.description)
        : unimplementedType(node, result.description);
    return b.genericTypeAnnotation.from(result.result);
  }

  function convertTypeReferenceLike(
    typeName: ts.EntityNameOrEntityNameExpression,
    typeArguments: ts.NodeArray<ts.TypeNode> | void
  ): ErrorOr<{
    id: K.IdentifierKind | n.QualifiedTypeIdentifier;
    typeParameters: n.TypeParameterInstantiation | null;
  }> {
    const symbol = checker.getSymbolAtLocation(typeName);
    const mapped = symbol && mapper.getSymbol(symbol);
    switch (mapped?.type) {
      case MapResultType.FixedName:
        return mkSuccess({
          id: b.identifier(mapped.name),
          typeParameters: convertTypeArguments(typeName, typeArguments),
        });

      case MapResultType.TypeReferenceMacro:
        return mapped.convert(converter, typeName, typeArguments);

      // TODO: How to get TypeScript to check that this switch is exhaustive?
      //   case undefined:
      //     break;
    }

    return mkSuccess({
      id: convertEntityNameAsType(typeName),
      typeParameters: convertTypeArguments(typeName, typeArguments),
    });
  }

  function convertEntityNameAsType(
    node: ts.EntityNameOrEntityNameExpression
  ): K.IdentifierKind | K.QualifiedTypeIdentifierKind {
    if (ts.isIdentifier(node)) return convertIdentifier(node);
    if (ts.isQualifiedName(node))
      return b.qualifiedTypeIdentifier(
        convertEntityNameAsType(node.left),
        convertIdentifier(node.right)
      );
    return b.qualifiedTypeIdentifier(
      convertEntityNameAsType(node.expression),
      convertIdentifier(node.name)
    );
  }

  function convertUnionType(node: ts.UnionTypeNode): K.FlowTypeKind {
    return b.unionTypeAnnotation(node.types.map(convertType));
  }

  function convertFunctionType(
    node:
      | ts.FunctionTypeNode
      | ts.FunctionDeclaration
      | ts.ConstructorDeclaration
      | ts.MethodDeclaration
  ): K.FlowTypeKind {
    const typeParams = convertTypeParameterDeclaration(node.typeParameters);

    const params: n.FunctionTypeParam[] = [];
    let restParam = null;
    for (let i = 0; i < node.parameters.length; i++) {
      const param = node.parameters[i];

      // TS requires a name for each parameter in a function type; you can
      // get out of it by using a binding-pattern instead.  Flow doesn't
      // require a name -- you can just write the type -- so if you don't
      // want a name, just omit it.
      //
      // We give up a bit of documentation value by discarding the pattern,
      // but that's all.
      const name = !ts.isIdentifier(param.name)
        ? null
        : convertIdentifier(param.name);

      if (param.dotDotDotToken) {
        // This is a rest parameter, so (if valid TS) must be the last one.
        restParam = b.functionTypeParam(
          name,
          // TS function parameter types must have names, but can lack types.
          // When missing, for a rest param the type is implicitly `any[]`.
          param.type
            ? convertType(param.type)
            : b.arrayTypeAnnotation(b.anyTypeAnnotation()),
          false
        );
        break;
      }

      params.push(
        b.functionTypeParam(
          name,
          // TS function parameter types must have names, but can lack types.
          // When missing, the type is implicitly `any`.
          param.type ? convertType(param.type) : b.anyTypeAnnotation(),
          !!param.questionToken
        )
      );
    }

    // TS function types always have explicit return types, but
    // FunctionDeclaration may not.  Implicitly that means `any`.
    const resultType = node.type
      ? convertType(node.type)
      : b.anyTypeAnnotation();

    return b.functionTypeAnnotation(params, resultType, restParam, typeParams);
  }

  function convertTypeLiteral(node: ts.TypeLiteralNode): K.FlowTypeKind {
    const properties: (
      | n.ObjectTypeProperty
      | n.ObjectTypeSpreadProperty
    )[] = [];
    for (let i = 0; i < node.members.length; i++) {
      const member = node.members[i];
      switch (member.kind) {
        case ts.SyntaxKind.PropertySignature: {
          const { name, questionToken, type } = member as ts.PropertySignature;
          properties.push(
            b.objectTypeProperty(
              convertIdentifier(name /* TODO */ as ts.Identifier),
              type ? convertType(type) : b.anyTypeAnnotation(),
              !!questionToken
            )
          );
          break;
        }

        case ts.SyntaxKind.CallSignature:
        case ts.SyntaxKind.ConstructSignature:
        case ts.SyntaxKind.MethodSignature:
        case ts.SyntaxKind.GetAccessor:
        case ts.SyntaxKind.SetAccessor:
        case ts.SyntaxKind.IndexSignature:
          return unimplementedType(
            node,
            `TypeElement kind: ${ts.SyntaxKind[member.kind]}`
          );

        default:
          return errorType(
            node,
            `unexpected TypeElement kind: ${ts.SyntaxKind[member.kind]}`
          );
      }
    }

    //   const indexers = undefined; // TODO
    //   const callProperties = undefined; // TODO
    const exact = true; // TODO

    return b.objectTypeAnnotation.from({
      properties,
      exact,
      inexact: !exact,
    });
  }

  function convertTypeParameterDeclaration(
    params: void | ts.NodeArray<ts.TypeParameterDeclaration>
  ): null | n.TypeParameterDeclaration {
    return !params
      ? null
      : b.typeParameterDeclaration(
          params.map((param) =>
            b.typeParameter(
              param.name.text,
              null,
              // TODO per param.constraint jsdoc: Consider calling `getEffectiveConstraintOfTypeParameter`
              !param.constraint
                ? null
                : b.typeAnnotation(convertType(param.constraint)),
              !param.default ? null : convertType(param.default)
            )
          )
        );
  }

  function convertTypeArguments(
    // TODO Really this just wants the symbol there; take the symbol instead?
    //   The caller probably needs to be looking it up anyway.
    typeName: ts.Node,
    typeArguments: void | ts.NodeArray<ts.TypeNode>
  ): null | n.TypeParameterInstantiation {
    if (typeArguments)
      return b.typeParameterInstantiation(typeArguments.map(convertType));

    // If in TS there was no list of type arguments, that can be either
    // because the type takes no parameters, or because it has defaults for
    // all parameters and this reference is using the defaults.  In the
    // latter case, while TS requires it to be spelled with no list, Flow
    // requires it to be spelled with an empty list.
    const symbol = checker.getSymbolAtLocation(typeName);
    // @ts-expect-error TODO(tsutil) express "does decl have type parameters"
    if (some(symbol?.declarations, (decl) => !!decl.typeParameters))
      return b.typeParameterInstantiation([]);

    return null;
  }

  function convertIdentifier(
    node: ts.Identifier,
    type?: K.FlowTypeKind
  ): K.IdentifierKind {
    // TODO(rename): audit this function's callers
    return !type
      ? b.identifier(node.text)
      : b.identifier.from({
          name: node.text,
          typeAnnotation: b.typeAnnotation(type),
        });
  }

  function warningStatement(
    outNode: K.StatementKind,
    node: ts.Statement,
    description: string
  ): K.StatementKind {
    const msg = ` tsflower-warning: ${description} `;
    return {
      ...outNode,
      // TODO(error): Get the quoted original before the output, to be next
      //   to the warning description
      comments: [b.commentBlock(msg, true, false), quotedStatement(node)],
    };
  }

  function unimplementedStatement(
    node: ts.Statement,
    description: string
  ): K.StatementKind {
    const msg = ` tsflower-unimplemented: ${description} `;
    return b.emptyStatement.from({
      comments: [b.commentBlock(msg, true, false), quotedStatement(node)],
    });
  }

  function errorStatement(
    node: ts.Statement,
    description: string
  ): K.StatementKind {
    const msg = ` tsflower-error: ${description} `;
    return b.emptyStatement.from({
      comments: [b.commentBlock(msg, true, false), quotedStatement(node)],
    });
  }

  function unimplementedType(
    node: ts.TypeNode,
    description: string
  ): K.FlowTypeKind {
    const msg = ` tsflower-unimplemented: ${description} `;
    return b.genericTypeAnnotation.from({
      id: b.identifier("$FlowFixMe"),
      typeParameters: null,
      comments: [quotedInlineNode(node), b.commentBlock(msg, false, true)],
    });
  }

  function errorType(node: ts.Node, description: string): K.FlowTypeKind {
    const msg = ` tsflower-error: ${description} `;
    return b.genericTypeAnnotation.from({
      id: b.identifier("$FlowFixMe"),
      typeParameters: null,
      comments: [quotedInlineNode(node), b.commentBlock(msg, false, true)],
    });
  }

  function quotedStatement(node: ts.Statement): K.CommentKind {
    const text = sourceFile.text.slice(node.pos, node.end);
    return b.commentBlock(` ${text} `, false, true);
  }

  function quotedInlineNode(node: ts.Node): K.CommentKind {
    const text = sourceFile.text.slice(node.pos, node.end);
    return b.commentBlock(` ${text} `, false, true);
  }

  function crudeError(node: ts.Node): never {
    // TODO(error): Better than node.pos would be a whitespace-trimmed version.
    //   (As is, when something is the first thing on its line `pos` can be
    //   the end of the last non-whitespace line.)
    const start = ts.getLineAndCharacterOfPosition(sourceFile, node.pos);
    const end = ts.getLineAndCharacterOfPosition(sourceFile, node.end);
    const loc =
      start.line === end.line
        ? `${1 + start.line}:${start.character}-${end.character}`
        : `${1 + start.line}-${1 + end.line}`;
    throw new Error(
      `Internal error on ${ts.SyntaxKind[node.kind]} at ${
        sourceFile.fileName
      }:${loc}`
    );
  }
}
