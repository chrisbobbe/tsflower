import ts from "typescript";
import { builders as b, namedTypes as n } from "ast-types";
import K from "ast-types/gen/kinds";
import { Converter, ErrorOr, mkError, mkSuccess } from "./convert";

/**
 * What to do to rewrite some type.
 */
export type TypeRewrite =
  | { kind: "FixedName"; name: string }
  /**
   * Rename this type, both at its definition and references.
   *
   * Used in particular where TS has a type and value sharing a name, which
   * Flow doesn't permit.  The value keeps the name, and the type gets a new
   * one.
   *
   * There's an asymmetry here: we don't have a "RenameValue".  That's
   * because we're translating type definitions, but those type definitions
   * describe some actual runtime JS, which we don't modify (or even see),
   * and the value name is a real fact about that actual runtime JS.
   */
  | { kind: "RenameType"; name: string }
  | {
      kind: "TypeReferenceMacro";
      convert(
        converter: Converter,
        typeName: ts.EntityNameOrEntityNameExpression,
        typeArguments: ts.NodeArray<ts.TypeNode> | void,
      ): ErrorOr<{
        id: K.IdentifierKind | n.QualifiedTypeIdentifier;
        typeParameters: n.TypeParameterInstantiation | null;
      }>;
    };

export type NamespaceRewrite = {
  types?: Map<string, TypeRewrite>;
  namespaces?: Map<string, NamespaceRewrite>;
};

function mkFixedName(name: string): TypeRewrite {
  return { kind: "FixedName", name };
}

function mkTypeReferenceMacro(
  convert: (
    converter: Converter,
    typeName: ts.EntityNameOrEntityNameExpression,
    typeArguments: ts.NodeArray<ts.TypeNode> | void,
  ) => ErrorOr<{
    id: K.IdentifierKind | n.QualifiedTypeIdentifier;
    typeParameters: n.TypeParameterInstantiation | null;
  }>,
): TypeRewrite {
  return { kind: "TypeReferenceMacro", convert };
}

function mkNamespaceRewrite(
  types: void | { readonly [name: string]: TypeRewrite },
  namespaces?: void | { readonly [name: string]: NamespaceRewrite },
): NamespaceRewrite {
  const r: NamespaceRewrite = {};
  if (types) r.types = new Map(Object.entries(types));
  if (namespaces) r.namespaces = new Map(Object.entries(namespaces));
  return r;
}

export const defaultLibraryRewrites: NamespaceRewrite = mkNamespaceRewrite({
  Readonly: mkFixedName("$ReadOnly"),
  ReadonlyArray: mkFixedName("$ReadOnlyArray"),
  Omit: mkTypeReferenceMacro(convertOmit),
  // If adding to this: note that any `namespaces` map is ignored.
  // See findRewritesInDefaultLibrary.
});

export const globalRewrites: NamespaceRewrite = mkNamespaceRewrite(undefined, {
  // If adding to this: note the unimplemented cases in findGlobalRewrites,
  // where we use this map.
  JSX: mkNamespaceRewrite({
    Element: mkTypeReferenceMacro(convertJsxElement),
  }),
});

export const libraryRewrites: Map<string, NamespaceRewrite> = new Map(
  // If adding to this: note that currently any namespace rewrites within a
  // given library are ignored!  That is, the `namespaces` property of one
  // of these NamespaceRewrite values is never consulted.  See use sites.
  Object.entries({
    react: mkNamespaceRewrite({
      Component: mkTypeReferenceMacro(convertReactComponent),
      ReactElement: mkTypeReferenceMacro(convertReactElement),
    }),
  }),
);

function convertOmit(
  converter: Converter,
  // @ts-expect-error yes, this is unused
  typeName: ts.EntityNameOrEntityNameExpression,
  typeArguments: ts.NodeArray<ts.TypeNode> | void,
): ErrorOr<{
  id: K.IdentifierKind | n.QualifiedTypeIdentifier;
  typeParameters: n.TypeParameterInstantiation | null;
}> {
  if (typeArguments?.length !== 2) {
    return mkError(
      `bad Omit: ${typeArguments?.length ?? 0} arguments (expected 2)`,
    );
  }
  const [objectType, keysType] = typeArguments;

  let subtrahend;
  if (ts.isLiteralTypeNode(keysType) && ts.isStringLiteral(keysType.literal)) {
    subtrahend = b.objectTypeAnnotation.from({
      exact: true,
      properties: [
        b.objectTypeProperty(
          b.stringLiteral(keysType.literal.text),
          b.mixedTypeAnnotation(),
          false,
        ),
      ],
    });
  } else if (
    ts.isUnionTypeNode(keysType) &&
    keysType.types.every(
      (t) => ts.isLiteralTypeNode(t) && ts.isStringLiteral(t.literal),
    )
  ) {
    subtrahend = b.objectTypeAnnotation.from({
      exact: true,
      properties: keysType.types.map((t) =>
        b.objectTypeProperty(
          b.stringLiteral(
            ((t as ts.LiteralTypeNode).literal as ts.StringLiteral).text,
          ),
          b.mixedTypeAnnotation(),
          false,
        ),
      ),
    });
  } else {
    subtrahend = b.objectTypeAnnotation.from({
      exact: true,
      properties: [],
      indexers: [
        b.objectTypeIndexer(
          b.identifier("key"),
          converter.convertType(keysType),
          b.mixedTypeAnnotation(),
        ),
      ],
    });
  }

  return mkSuccess({
    id: b.identifier("$Diff"),
    typeParameters: b.typeParameterInstantiation([
      converter.convertType(objectType),
      subtrahend,
    ]),
  });
}

function convertReactComponent(
  converter: Converter,
  typeName: ts.EntityNameOrEntityNameExpression,
  typeArguments: ts.NodeArray<ts.TypeNode> | void,
): ErrorOr<{
  id: K.IdentifierKind | n.QualifiedTypeIdentifier;
  typeParameters: n.TypeParameterInstantiation | null;
}> {
  if ((typeArguments?.length ?? 0) > 2) {
    return mkError(
      `bad React.Component: ${
        typeArguments?.length ?? 0
      } arguments (expected 0-2)`,
    );
  }
  const [propsType, stateType] = typeArguments ?? [];

  const args = [
    propsType
      ? converter.convertType(propsType)
      : b.objectTypeAnnotation.from({ properties: [], inexact: true }),
    ...(stateType ? [converter.convertType(stateType)] : []),
  ];

  return mkSuccess({
    id: converter.convertEntityNameAsType(typeName),
    typeParameters: b.typeParameterInstantiation(args),
  });
}

function convertReactElement(
  converter: Converter,
  // @ts-expect-error yes, this is unused
  typeName: ts.EntityNameOrEntityNameExpression,
  typeArguments: ts.NodeArray<ts.TypeNode> | void,
) {
  // TODO: If ReactElement is imported individually, we also need to rewrite
  //   that import.

  if ((typeArguments?.length ?? 0) > 2) {
    return mkError(
      `bad React.Element: ${
        typeArguments?.length ?? 0
      } arguments (expected 0-2)`,
    );
  }
  const [propsType, typeType] = typeArguments ?? [];

  let args;
  if (!propsType) {
    args = [b.genericTypeAnnotation(b.identifier("React$ElementType"), null)];
  } else if (!typeType) {
    args = [
      b.genericTypeAnnotation(
        b.identifier("React$ComponentType"),
        b.typeParameterInstantiation([converter.convertType(propsType)]),
      ),
    ];
  } else {
    args = [converter.convertType(typeType)];
  }

  return mkSuccess({
    id: b.identifier("React$Element"), // TODO use import
    typeParameters: b.typeParameterInstantiation(args),
  });
}

// // @types/react/index.d.ts
// declare global {
//   namespace JSX {
//       interface Element extends React.ReactElement<any, any> { }
//
// So do the equivalent of convertReactElement with `any, any`.
function convertJsxElement() {
  return mkSuccess({
    id: b.identifier("React$Element"), // TODO use import
    typeParameters: b.typeParameterInstantiation([b.anyTypeAnnotation()]),
  });
}
