import {
  GraphQLSchema,
  isSpecifiedDirective,
  isIntrospectionType,
  isSpecifiedScalarType,
  GraphQLNamedType,
  GraphQLDirective,
  isScalarType,
  isObjectType,
  isInterfaceType,
  isUnionType,
  isEnumType,
  isInputObjectType,
  GraphQLScalarType,
  GraphQLObjectType,
  GraphQLInterfaceType,
  GraphQLUnionType,
  GraphQLEnumType,
  GraphQLInputObjectType,
  GraphQLArgument,
  GraphQLInputField,
  astFromValue,
  print,
  GraphQLField,
  GraphQLEnumValue,
  GraphQLString,
  DEFAULT_DEPRECATION_REASON,
  ASTNode,
  SelectionNode,
} from 'graphql';
import { Maybe, FederationType, FederationField, ServiceDefinition } from '../composition';
import { CoreDirective } from '../coreSpec';
import { getJoins } from '../joinSpec';

type Options = {
  /**
   * Descriptions are defined as preceding string literals, however an older
   * experimental version of the SDL supported preceding comments as
   * descriptions. Set to true to enable this deprecated behavior.
   * This option is provided to ease adoption and will be removed in v16.
   *
   * Default: false
   */
  commentDescriptions?: boolean;
};

/**
 * Accepts options as an optional third argument:
 *
 *    - commentDescriptions:
 *        Provide true to use preceding comments as the description.
 *
 */
// Core change: we need service and url information for the join__Graph enum
export function printCoreSchema(
  schema: GraphQLSchema,
  serviceList: ServiceDefinition[],
  options?: Options,
): string {
  const config = schema.toConfig();

  const {
    FieldSetScalar,
    JoinFieldDirective,
    JoinTypeDirective,
    JoinOwnerDirective,
    JoinGraphEnum,
  } = getJoins(serviceList);

  schema = new GraphQLSchema({
    ...config,
    directives: [
      CoreDirective,
      JoinFieldDirective,
      JoinTypeDirective,
      JoinOwnerDirective,
      ...config.directives,
    ],
    types: [FieldSetScalar, JoinGraphEnum, ...config.types],
  });

  return printFilteredSchema(
    schema,
    (n) => !isSpecifiedDirective(n),
    isDefinedType,
    options,
  );
}

export function printIntrospectionSchema(
  schema: GraphQLSchema,
  options?: Options,
): string {
  return printFilteredSchema(
    schema,
    isSpecifiedDirective,
    isIntrospectionType,
    options,
  );
}

function isDefinedType(type: GraphQLNamedType): boolean {
  return !isSpecifiedScalarType(type) && !isIntrospectionType(type);
}

function printFilteredSchema(
  schema: GraphQLSchema,
  // serviceList: ServiceDefinition[],
  directiveFilter: (type: GraphQLDirective) => boolean,
  typeFilter: (type: GraphQLNamedType) => boolean,
  options?: Options,
): string {
  const directives = schema.getDirectives().filter(directiveFilter);
  const types = Object.values(schema.getTypeMap())
    .sort((type1, type2) => type1.name.localeCompare(type2.name))
    .filter(typeFilter);

  return (
    [printSchemaDefinition(schema)]
      .concat(
        directives.map(directive => printDirective(directive, options)),
        types.map(type => printType(type, options)),
      )
      .filter(Boolean)
      .join('\n\n') + '\n'
  );
}

function printSchemaDefinition(schema: GraphQLSchema): string {
  const operationTypes = [];

  const queryType = schema.getQueryType();
  if (queryType) {
    operationTypes.push(`  query: ${queryType.name}`);
  }

  const mutationType = schema.getMutationType();
  if (mutationType) {
    operationTypes.push(`  mutation: ${mutationType.name}`);
  }

  const subscriptionType = schema.getSubscriptionType();
  if (subscriptionType) {
    operationTypes.push(`  subscription: ${subscriptionType.name}`);
  }

  return (
    'schema' +
    // Core change: print @core directive usages on schema node
    printCoreDirectives() +
    `\n{\n${operationTypes.join('\n')}\n}`
  );
}

function printCoreDirectives() {
  return [
    'https://lib.apollo.dev/core/v0.1',
    'https://lib.apollo.dev/join/v0.1',
  ].map((feature) => `\n  @core(feature: "${feature}")`);
}

export function printType(type: GraphQLNamedType, options?: Options): string {
  if (isScalarType(type)) {
    return printScalar(type, options);
  } else if (isObjectType(type)) {
    return printObject(type, options);
  } else if (isInterfaceType(type)) {
    return printInterface(type, options);
  } else if (isUnionType(type)) {
    return printUnion(type, options);
  } else if (isEnumType(type)) {
    return printEnum(type, options);
  } else if (isInputObjectType(type)) {
    return printInputObject(type, options);
  }

  throw Error('Unexpected type: ' + (type as GraphQLNamedType).toString());
}

function printScalar(type: GraphQLScalarType, options?: Options): string {
  return printDescription(options, type) + `scalar ${type.name}`;
}

function printObject(type: GraphQLObjectType, options?: Options): string {
  const interfaces = type.getInterfaces();
  const implementedInterfaces = interfaces.length
    ? ' implements ' + interfaces.map((i) => i.name).join(' & ')
    : '';

  // TODO: I can't figure out why this is here. I wrote this 8 months ago. Nothing
  // in the history explains the reason this is needed. When do we have an `extend type`
  // in the final composed schema?
  //
  // Core change: print `extend` keyword on type extensions.
  //
  // The implementation assumes that an owned type will have fields defined
  // since that is required for a valid schema. Types that are *only*
  // extensions will not have fields on the astNode since that ast doesn't
  // exist.
  //
  // XXX revist extension checking
  const isExtension =
    type.extensionASTNodes && type.astNode && !type.astNode.fields;

  return (
    printDescription(options, type) +
    (isExtension ? 'extend ' : '') +
    `type ${type.name}` +
    implementedInterfaces +
    // Core addition for printing @join__owner and @join__type usages
    printTypeJoinDirectives(type) +
    printFields(options, type)
  );
}

// Core change: print @join__owner and @join__type usages
function printTypeJoinDirectives(type: GraphQLObjectType): string {
  const metadata: FederationType = type.extensions?.federation;
  if (!metadata) return '';

  const { serviceName: ownerService, keys } = metadata;
  if (!ownerService || !keys) return '';

  // Separate owner @keys from the rest of the @keys so we can print them
  // adjacent to the @owner directive.
  const { [ownerService]: ownerKeys = [], ...restKeys } = keys
  const ownerEntry: [string, (readonly SelectionNode[])[]] = [ownerService, ownerKeys];
  const restEntries = Object.entries(restKeys);

  return (
    `\n  @join__owner(graph: ${ownerService.toUpperCase()})` +
    [ownerEntry, ...restEntries]
      .map(([service, keys = []]) =>
        keys
          .map(
            (selections) =>
              `\n  @join__type(graph: ${service.toUpperCase()}, key: "${printFieldSet(
                selections,
              )}")`,
          )
          .join(''),
      )
      .join('')
  );
}

function printInterface(type: GraphQLInterfaceType, options?: Options): string {
  // TODO: I can't figure out why this is here. I wrote this 8 months ago. Nothing
  // in the history explains the reason this is needed. When do we have an `extend type`
  // in the final composed schema?
  //
  // Core change: print `extend` keyword on type extensions.
  // See printObject for assumptions made.
  //
  // XXX revist extension checking
  const isExtension =
    type.extensionASTNodes && type.astNode && !type.astNode.fields;

  return (
    printDescription(options, type) +
    (isExtension ? 'extend ' : '') +
    `interface ${type.name}` +
    printFields(options, type)
  );
}

function printUnion(type: GraphQLUnionType, options?: Options): string {
  const types = type.getTypes();
  const possibleTypes = types.length ? ' = ' + types.join(' | ') : '';
  return printDescription(options, type) + 'union ' + type.name + possibleTypes;
}

function printEnum(type: GraphQLEnumType, options?: Options): string {
  const values = type
    .getValues()
    .map(
      (value, i) =>
        printDescription(options, value, '  ', !i) +
        '  ' +
        value.name +
        printDeprecated(value) +
        printHttpDirective(type, value),
    );

  return (
    printDescription(options, type) + `enum ${type.name}` + printBlock(values)
  );
}

function printHttpDirective(type: GraphQLEnumType, value: GraphQLEnumValue) {
  if (type.name === "join__Graph") {
    return ` @http(url: "${value.value}")`
  }
  return '';
}

function printInputObject(
  type: GraphQLInputObjectType,
  options?: Options,
): string {
  const fields = Object.values(type.getFields()).map(
    (f, i) =>
      printDescription(options, f, '  ', !i) + '  ' + printInputValue(f),
  );
  return (
    printDescription(options, type) + `input ${type.name}` + printBlock(fields)
  );
}

function printFields(
  options: Options | undefined,
  type: GraphQLObjectType | GraphQLInterfaceType,
) {

  const fields = Object.values(type.getFields()).map(
    (f, i) =>
      printDescription(options, f, '  ', !i) +
      '  ' +
      f.name +
      printArgs(options, f.args, '  ') +
      ': ' +
      String(f.type) +
      printDeprecated(f) +
      printJoinFieldDirectives(f, type),
  );

  // Core change: for entities, we want to print the block on a new line.
  // This is just a formatting nice-to-have.
  const isEntity = Boolean(type.extensions?.federation?.keys);

  return printBlock(fields, isEntity);
}

export function printWithReducedWhitespace(ast: ASTNode): string {
  return print(ast)
    .replace(/\s+/g, ' ')
    .trim();
}

/**
 * Core change: print fieldsets for @join__field's @key, @requires, and @provides args
 *
 * @param selections
 */
function printFieldSet(selections: readonly SelectionNode[]): string {
  return `${selections.map(printWithReducedWhitespace).join(' ')}`;
}

/**
 * Core change: print @join__field directives
 *
 * @param field
 * @param parentType
 */
function printJoinFieldDirectives(
  field: GraphQLField<any, any>,
  parentType: GraphQLObjectType | GraphQLInterfaceType,
): string {
  let printed = ' @join__field(graph: ';
  // Fields on the owning service do not have any federation metadata applied
  // TODO: maybe make this metadata available? Though I think this is intended and we may depend on that implicity.
  if (!field.extensions?.federation) {
    if (parentType.extensions?.federation?.serviceName) {
      return printed + `${parentType.extensions?.federation.serviceName.toUpperCase()})`;
    }
    return '';
  }

  const {
    serviceName,
    requires = [],
    provides = [],
  }: FederationField = field.extensions.federation;

  if (serviceName) {
    printed += serviceName.toUpperCase();
  }

  if (requires.length > 0) {
    printed += `, requires: "${printFieldSet(requires)}"`;
  }

  if (provides.length > 0) {
    printed += `, provides: "${printFieldSet(provides)}"`;
  }

  return (printed += ')');
}

// Core change: `onNewLine` is a formatting nice-to-have for printing
// types that have a list of directives attached, i.e. an entity.
function printBlock(items: string[], onNewLine?: boolean) {
  return items.length !== 0
    ? onNewLine
      ? '\n{\n' + items.join('\n') + '\n}'
      : ' {\n' + items.join('\n') + '\n}'
    : '';
}

function printArgs(
  options: Options | undefined,
  args: GraphQLArgument[],
  indentation = '',
) {
  if (args.length === 0) {
    return '';
  }

  // If every arg does not have a description, print them on one line.
  if (args.every((arg) => !arg.description)) {
    return '(' + args.map(printInputValue).join(', ') + ')';
  }

  return (
    '(\n' +
    args
      .map(
        (arg, i) =>
          printDescription(options, arg, '  ' + indentation, !i) +
          '  ' +
          indentation +
          printInputValue(arg),
      )
      .join('\n') +
    '\n' +
    indentation +
    ')'
  );
}

function printInputValue(arg: GraphQLInputField) {
  const defaultAST = astFromValue(arg.defaultValue, arg.type);
  let argDecl = arg.name + ': ' + String(arg.type);
  if (defaultAST) {
    argDecl += ` = ${print(defaultAST)}`;
  }
  return argDecl;
}

function printDirective(directive: GraphQLDirective, options?: Options) {
  return (
    printDescription(options, directive) +
    'directive @' +
    directive.name +
    printArgs(options, directive.args) +
    (directive.isRepeatable ? ' repeatable' : '') +
    ' on ' +
    directive.locations.join(' | ')
  );
}

function printDeprecated(
  fieldOrEnumVal: GraphQLField<any, any> | GraphQLEnumValue,
) {
  if (!fieldOrEnumVal.isDeprecated) {
    return '';
  }
  const reason = fieldOrEnumVal.deprecationReason;
  const reasonAST = astFromValue(reason, GraphQLString);
  if (reasonAST && reason !== DEFAULT_DEPRECATION_REASON) {
    return ' @deprecated(reason: ' + print(reasonAST) + ')';
  }
  return ' @deprecated';
}

function printDescription<T extends { description?: Maybe<string> }>(
  options: Options | undefined,
  def: T,
  indentation = '',
  firstInBlock = true,
): string {
  const { description } = def;
  if (description == null) {
    return '';
  }

  if (options?.commentDescriptions === true) {
    return printDescriptionWithComments(description, indentation, firstInBlock);
  }

  const preferMultipleLines = description.length > 70;
  const blockString = printBlockString(description, '', preferMultipleLines);
  const prefix =
    indentation && !firstInBlock ? '\n' + indentation : indentation;

  return prefix + blockString.replace(/\n/g, '\n' + indentation) + '\n';
}

function printDescriptionWithComments(
  description: string,
  indentation: string,
  firstInBlock: boolean,
) {
  const prefix = indentation && !firstInBlock ? '\n' : '';
  const comment = description
    .split('\n')
    .map((line) => indentation + (line !== '' ? '# ' + line : '#'))
    .join('\n');

  return prefix + comment + '\n';
}

/**
 * Print a block string in the indented block form by adding a leading and
 * trailing blank line. However, if a block string starts with whitespace and is
 * a single-line, adding a leading blank line would strip that whitespace.
 *
 * @internal
 */
export function printBlockString(
  value: string,
  indentation: string = '',
  preferMultipleLines: boolean = false,
): string {
  const isSingleLine = value.indexOf('\n') === -1;
  const hasLeadingSpace = value[0] === ' ' || value[0] === '\t';
  const hasTrailingQuote = value[value.length - 1] === '"';
  const hasTrailingSlash = value[value.length - 1] === '\\';
  const printAsMultipleLines =
    !isSingleLine ||
    hasTrailingQuote ||
    hasTrailingSlash ||
    preferMultipleLines;

  let result = '';
  // Format a multi-line block quote to account for leading space.
  if (printAsMultipleLines && !(isSingleLine && hasLeadingSpace)) {
    result += '\n' + indentation;
  }
  result += indentation ? value.replace(/\n/g, '\n' + indentation) : value;
  if (printAsMultipleLines) {
    result += '\n';
  }

  return '"""' + result.replace(/"""/g, '\\"""') + '"""';
}
