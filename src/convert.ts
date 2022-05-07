import ts from "typescript";
import { builders as b, namedTypes as n } from "ast-types";
import K from "ast-types/gen/kinds";
import { forEach, map, some } from "./util";
import { Mapper, MapResultType } from "./mapper";

export interface Converter {
  convertType(node: ts.TypeNode): K.FlowTypeKind;
  errorType(node: ts.TypeNode, description: string): K.FlowTypeKind;
  unimplementedType(node: ts.TypeNode): K.FlowTypeKind;
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

      if (
        some(node.modifiers, (mod) => mod.kind === ts.SyntaxKind.ExportKeyword)
      ) {
        return modifyStatementAsExport(inner);
      }

      return inner;
    } catch (err) {
      console.error(err);
      return errorStatement(node, `internal error: ${(err as Error).message}`);
    }
  }

  function modifyStatementAsExport(inner: K.StatementKind): K.StatementKind {
    if (!n.Declaration.check(inner)) {
      if (n.EmptyStatement.check(inner)) {
        // Presumably an error or unimplemented.  Nothing further to log.
        return inner;
      }

      console.error(
        `warning: statement has "export", but conversion not a declaration`
      );
      // TODO(error) better log this; note in output
      return inner;
    }

    if (n.DeclareClass.check(inner)) {
      // TODO are there more cases that should go this way?
      return b.declareExportDeclaration(/* TODO: defaultParam */ false, inner);
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
    } else {
      return b.exportNamedDeclaration(inner as K.DeclarationKind);
    }
  }

  function convertStatementExceptExport(node: ts.Statement): K.StatementKind {
    switch (node.kind) {
      case ts.SyntaxKind.ImportDeclaration:
        return convertImportDeclaration(node as ts.ImportDeclaration);

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
      case ts.SyntaxKind.VariableDeclaration:
      case ts.SyntaxKind.VariableDeclarationList:
      case ts.SyntaxKind.EnumDeclaration:
      case ts.SyntaxKind.ModuleDeclaration:
      case ts.SyntaxKind.ModuleBlock:
      case ts.SyntaxKind.CaseBlock:
      case ts.SyntaxKind.NamespaceExportDeclaration:
      case ts.SyntaxKind.ImportEqualsDeclaration:
      case ts.SyntaxKind.ImportClause:
      case ts.SyntaxKind.NamespaceImport:
      case ts.SyntaxKind.NamedImports:
      case ts.SyntaxKind.ImportSpecifier:
      case ts.SyntaxKind.ExportDeclaration:
      case ts.SyntaxKind.NamedExports:
      case ts.SyntaxKind.NamespaceExport:
      case ts.SyntaxKind.ExportSpecifier:
      case ts.SyntaxKind.MissingDeclaration:
        return unimplementedStatement(node);

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
    if (!importClause) throw new Error("unimplemented: no import clause");

    if (importClause.modifiers)
      return errorStatement(
        node,
        `unimplemented: ImportDeclaration with modifiers`
      );

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
          const isNonValue =
            importedSymbol &&
            !!(
              importedSymbol.flags &
              (ts.SymbolFlags.Interface |
                ts.SymbolFlags.TypeLiteral |
                ts.SymbolFlags.TypeAlias)
            );

          specifiers.push(
            b.importSpecifier.from({
              imported: convertIdentifier(binding.propertyName ?? binding.name),
              local: convertIdentifier(binding.name),
              // TODO: use modifier on this ts.ImportSpecifier, if present.
              importKind: isNonValue ? "type" : "value",
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

  function convertExportAssignment(node: ts.ExportAssignment): K.StatementKind {
    if (node.isExportEquals)
      // TODO(error): make this a proper "unimplemented"
      return errorStatement(node, 'unimplemented: "export ="');

    if (!ts.isIdentifier(node.expression))
      // TODO(runtime): These don't appear in .d.ts files, but do in TS.
      return errorStatement(node, `"export default" with non-identifier`);

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
    if (!node.name) crudeError(node); // TODO(error)

    return b.declareFunction(
      convertIdentifier(node.name, convertFunctionType(node))
    );
  }

  function convertClassLikeDeclaration(
    node: ts.ClassDeclaration | ts.InterfaceDeclaration
  ) {
    if (!node.name) crudeError(node); // TODO(error): really unimplemented `export default class`

    const typeParameters = convertTypeParameterDeclaration(node.typeParameters);

    const extends_: n.InterfaceExtends[] = [];
    forEach(node.heritageClauses, (heritageClause) => {
      const { token, types } = heritageClause;
      if (token === ts.SyntaxKind.ExtendsKeyword) {
        for (const base of types) {
          const { expression, typeArguments } = base;
          if (!ts.isEntityName(expression)) {
            return errorStatement(
              node,
              `unexpected 'extends' base kind: ${
                ts.SyntaxKind[expression.kind]
              }`
            );
          }
          if (!ts.isIdentifier(expression)) {
            return errorStatement(
              node, // TODO
              `unimplemented: qualified name in 'extends'`
            );
          }
          extends_.push(
            b.interfaceExtends.from({
              id: convertIdentifier(expression),
              typeParameters: convertTypeArguments(typeArguments),
            })
          );
        }
      } else {
        // TODO
        return errorStatement(node, `unimplemented: class 'implements'`);
      }
    });

    const properties: (
      | n.ObjectTypeProperty
      | n.ObjectTypeSpreadProperty
    )[] = [];
    const indexers: n.ObjectTypeIndexer[] | undefined = []; // TODO
    const callProperties: n.ObjectTypeCallProperty[] | undefined = []; // TODO
    node.members.forEach((member) => {
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

        case ts.SyntaxKind.PropertyDeclaration:
        case ts.SyntaxKind.MethodDeclaration:
        case ts.SyntaxKind.SemicolonClassElement:
        case ts.SyntaxKind.GetAccessor:
        case ts.SyntaxKind.SetAccessor:
        case ts.SyntaxKind.IndexSignature:
        case ts.SyntaxKind.ClassStaticBlockDeclaration:
          throw new Error(
            `unimplemented ClassElement kind: ${ts.SyntaxKind[member.kind]}`
          );

        default:
          crudeError(node); // TODO(error)
      }
    });

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

      case ts.SyntaxKind.ParenthesizedType:
        // TODO: Am I missing something?
        return convertType((node as ts.ParenthesizedTypeNode).type);

      case ts.SyntaxKind.LiteralType:
        return convertLiteralType(node as ts.LiteralTypeNode);

      case ts.SyntaxKind.TypeReference:
        return convertTypeReference(node as ts.TypeReferenceNode);

      case ts.SyntaxKind.UnionType:
        return convertUnionType(node as ts.UnionTypeNode);

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
      case ts.SyntaxKind.TypeQuery:
      case ts.SyntaxKind.OptionalType:
      case ts.SyntaxKind.RestType:
      case ts.SyntaxKind.IntersectionType:
      case ts.SyntaxKind.ConditionalType:
      case ts.SyntaxKind.InferType:
      case ts.SyntaxKind.ThisType:
      case ts.SyntaxKind.TypeOperator:
      case ts.SyntaxKind.MappedType:
      case ts.SyntaxKind.LiteralType:
      case ts.SyntaxKind.NamedTupleMember:
      case ts.SyntaxKind.TemplateLiteralType:
      case ts.SyntaxKind.TemplateLiteralTypeSpan:
      case ts.SyntaxKind.ImportType:
        return unimplementedType(node);

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
        if (
          literal.operator !== ts.SyntaxKind.MinusToken ||
          !ts.isNumericLiteral(literal.operand)
        )
          crudeError(node); // TODO(error)
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

  function convertTypeReference(node: ts.TypeReferenceNode): K.FlowTypeKind {
    const symbol = checker.getSymbolAtLocation(node.typeName);
    const mapped = symbol && mapper.getSymbol(symbol);
    switch (mapped?.type) {
      case MapResultType.FixedName:
        return b.genericTypeAnnotation(
          b.identifier(mapped.name),
          !node.typeArguments
            ? null
            : b.typeParameterInstantiation(node.typeArguments.map(convertType))
        );

      case MapResultType.TypeReferenceMacro:
        return mapped.convert(converter, node);

      // TODO: How to get TypeScript to check that this switch is exhaustive?
      //   case undefined:
      //     break;
    }

    return b.genericTypeAnnotation(
      convertEntityNameAsType(node.typeName),
      !node.typeArguments
        ? null
        : b.typeParameterInstantiation(node.typeArguments.map(convertType))
    );
  }

  function convertEntityNameAsType(
    node: ts.EntityName
  ): K.IdentifierKind | K.QualifiedTypeIdentifierKind {
    return ts.isIdentifier(node)
      ? convertIdentifier(node)
      : b.qualifiedTypeIdentifier(
          convertEntityNameAsType(node.left),
          convertIdentifier(node.right)
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
  ): K.FlowTypeKind {
    const typeParams = convertTypeParameterDeclaration(node.typeParameters);

    const params: n.FunctionTypeParam[] = [];
    let restParam = null;
    for (let i = 0; i < node.parameters.length; i++) {
      const param = node.parameters[i];

      const name = convertIdentifier(param.name /* TODO */ as ts.Identifier);

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
          throw new Error(
            `unimplemented TypeElement kind: ${ts.SyntaxKind[member.kind]}`
          );

        default:
          crudeError(node); // TODO(error)
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
                : b.typeAnnotation(convertType(param.constraint))
            )
          )
        );
  }

  function convertTypeArguments(
    typeArguments: void | ts.NodeArray<ts.TypeNode>
  ): null | n.TypeParameterInstantiation {
    return !typeArguments
      ? null
      : b.typeParameterInstantiation(typeArguments.map(convertType));
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

  function unimplementedStatement(node: ts.Statement): K.StatementKind {
    const msg = ` tsflower-unimplemented: ${ts.SyntaxKind[node.kind]} `;
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

  function unimplementedType(node: ts.TypeNode): K.FlowTypeKind {
    const msg = ` tsflower-unimplemented: ${ts.SyntaxKind[node.kind]} `;
    return b.genericTypeAnnotation.from({
      id: b.identifier("$FlowFixMe"),
      typeParameters: null,
      comments: [quotedInlineNode(node), b.commentBlock(msg, false, true)],
    });
  }

  function errorType(node: ts.TypeNode, description: string): K.FlowTypeKind {
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
    throw new Error(
      `Internal error on ${ts.SyntaxKind[node.kind]} at ${
        sourceFile.fileName
      }:${node.pos}:${node.end}:`
    );
  }
}
