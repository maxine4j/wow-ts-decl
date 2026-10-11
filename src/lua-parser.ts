import type luaparse from 'luaparse';
import { P, match } from 'ts-pattern';
import { SyntaxKind, factory } from 'typescript';

import camelCase from 'lodash/camelCase.js';
import capitalize from 'lodash/capitalize.js';
import type { TableValue } from 'luaparse';
import type {
  EventSignature,
  FileAPIDocumentation,
  FunctionSignature,
  TableSignature,
  VariableSignature,
} from '#@/types.js';
import { printList, unhandledBranch } from '#@/utils.js';

const { createKeywordTypeNode, createEnumDeclaration } = factory;

export const visitedTypes = new Set<string>();
export const typesMaybeNotAccountedFor = new Set<string>();

type TableField = luaparse.TableValue & {
  value: luaparse.TableConstructorExpression;
};

const explicitlyPassthroughTypes = [
  // 11.0.7
  'AccountStoreCategoryType',
  'AccountStoreItemStatus',
  'AccountStoreItemFlag',
  'AccountStoreState',
  'ArtifactTiers',
  'stringView',
  'GarrisonFollower',
  'ItemCreationContext',
  'mouseButton',
  'LuaValueVariant',
  'PartyPlaylistEntry',
  'UiMapPoint',
  'RecruitAcceptanceID',
  'TooltipData',
  'WeeklyRewardItemDBID',
  'InventorySlots',
  'WeeklyRewardChestThresholdType',
  'CachedRewardType',

  // 1.15.4
  'AzeriteEmpoweredItemLocation',
  'ItemInfo',
  'ItemLocation',
  'AzeriteItemLocation',
  'NotificationDbId',
  'CalendarEventID',
  'ClubId',
  'ChatBubbleFrame',
  'PlayerLocation',
  'BigUInteger',
  'ClubInvitationId',
  'kstringClubMessage',
  'ClubStreamId',
  'BigInteger',
  'UnitToken',
  'ConnectionIptype',
  'WOWMONEY',
  'FramePoint',
  'FileAsset',
  'AnimationDataEnum',
  'SingleColorValue',
  'IDOrLink',
  'DrawLayer',
  'uiRect',
  'TextureAssetDisk',
  'SimpleWindow',
  'GameMode',
  'GameRule',
  'ScriptRegion',
  'EmptiableItemLocation',
  'ItemTransmogInfo',
  'kstringLfgListApplicant',
  'kstringLfgListSearch',
  'kstringLfgListChat',
  'TextureAsset',
  'NamePlateFrame',
  'SimpleFrame',
  'RoleShortageReward',
  'ReportInfo',
  'CScriptObject',
  'luaFunction',
  'SmoothingType',
  'SimpleAnimGroup',
  'SimpleAnim',
  'LoopType',
  'SimpleControlPoint',
  'CurveType',
  'SimpleButtonStateToken',
  'SimpleFont',
  'SimpleFontString',
  'BlendMode',
  'SimplePathAnim',
  'TBFFlags',
  'JustifyHorizontal',
  'JustifyVertical',
  'uiFontHeight',
  'SimpleLine',
  'SimpleMaskTexture',
  'FrameStrata',
  'HTMLTextType',
  'InsertMode',
  'ModelAsset',
  'Orientation',
  'StatusBarFillStyle',
  'normalizedValue',
  'size',
  'FilterMode',
  'ItemSoundType',
  'SpellIdentifier',
  'CallbackType',
  'TooltipComparisonItem',
  'TransmogLocation',
  'TransmogPendingInfo',
  'ModelSceneFrame',
  'ModelSceneFrameActor',
  'AuraData',
] as const;

function explicitlyMapType(parsedType: string) {
  return (
    match(parsedType)
      .with('cstring', 'textureAtlas', () => printList([createKeywordTypeNode(SyntaxKind.StringKeyword)]).trim())
      .with('bool', () => printList([createKeywordTypeNode(SyntaxKind.BooleanKeyword)]).trim())
      .with('XMLTemplateKeyValue', 'Structure', 'table', () =>
        printList([createKeywordTypeNode(SyntaxKind.ObjectKeyword)]).trim(),
      )
      // Enumeration references are available as Enum.<entry> in the global scope -> declare const Enum: WoWAPI.Enum;
      .with('Enumeration', () => 'Enum')
      // Constants references are available as Constants.<entry> in the global scope -> declare const Constants: WoWAPI.Constants;
      .with('Constants', () => 'Constants')
      .with('WOWGUID', () => 'GUID')
      .with(P.string.startsWith('vector'), P.string.startsWith('colorRGB'), 'textureKit', (v) => capitalize(v))
      .with('fileID', () => 'FileId')
      .with('Vocalerrorsounds', () => 'VocalErrorSounds')
      .with('uiUnit', () => 'UIUnit')
      .with('uiAddon', () => 'UIAddon')
      .with('time_t', () => 'Date')
      .with('string', 'number', 'SimpleTexture', ...explicitlyPassthroughTypes, (t) => t)
      .with('luaIndex', () => 'LuaIndex')
      .otherwise((t) => {
        if (!visitedTypes.has(t)) {
          typesMaybeNotAccountedFor.add(t);
        }

        return t;
      })
  );
}

export function toAPIDefinition(apiDefinition: Partial<FileAPIDocumentation>, field: luaparse.TableKeyString) {
  switch (true) {
    case isName(field): {
      apiDefinition.name = JSON.parse(field.value.raw);
      break;
    }
    case isType(field): {
      // Don't care
      // func.type = JSON.parse(field.value.raw);
      break;
    }
    case isNamespace(field): {
      apiDefinition.ns = JSON.parse(field.value.raw);
      break;
    }
    case isDocumentation(field): {
      // There's some Pony documentation :shrug:
      break;
    }
    case isFunctionList(field): {
      apiDefinition.functions = field.value.fields.filter(isTableField).map((func) => {
        return func.value.fields.filter(isKeyValueField).reduce(toFunction, {} as FunctionSignature);
      });
      break;
    }
    case isTableList(field): {
      apiDefinition.tables = field.value.fields.filter(isTableField).map((table) => {
        return table.value.fields.filter(isKeyValueField).reduce(toTable, {} as TableSignature);
      });
      break;
    }
    case isEventList(field): {
      apiDefinition.events = field.value.fields.filter(isTableField).map((func) => {
        return func.value.fields.filter(isKeyValueField).reduce(toEvent, {} as EventSignature);
      });
      break;
    }
    default:
      unhandledBranch(field);
  }

  return apiDefinition;
}

export function toProperty(field: TableField) {
  return field.value.fields.filter(isKeyValueField).reduce(toVariableSignature(field.type), {} as VariableSignature);
}

export function toFunction(func: FunctionSignature, field: luaparse.TableKeyString) {
  switch (true) {
    case isName(field): {
      func.name = JSON.parse(field.value.raw);
      break;
    }
    case isDocumentation(field): {
      func.description = field.value.fields
        .filter(isTableValue)
        .map((v) => {
          try {
            return JSON.parse(v.value.raw)
          } catch (error) {
            console.warn("Failed to JSON parse raw table field")
            return "Unknown - parsing error"
          }
        })
        .join('\n');
      break;
    }
    case isType(field): {
      // Don't care
      // func.type = JSON.parse(field.value.raw);
      break;
    }
    case isParameters(field): {
      func.parameters = field.value.fields.filter(isTableField).map(toProperty);

      break;
    }
    case isReturns(field): {
      func.returns = field.value.fields.filter(isTableField).map(toProperty);

      break;
    }
    default:
      unhandledBranch(field);
  }

  return func;
}

export function toTable(table: TableSignature, field: luaparse.TableKeyString) {
  switch (true) {
    case isName(field): {
      table.name = JSON.parse(field.value.raw);
      visitedTypes.add(table.name);
      break;
    }
    case isEnumRange(field): {
      // Don't care
      // event.type = JSON.parse(field.value.raw);
      break;
    }
    case isDocumentation(field): {
      table.description = field.value.fields
        .filter(isTableValue)
        .map((v) => JSON.parse(v.value.raw))
        .join('\n');
      break;
    }
    case isParameters(field): {
      // NOTE: See the comment for the table schema - not sure what the meaning
      // of this is - perhaps a wrongly categorized entry
      table.parameters = field.value.fields.filter(isTableField).map(toProperty);
      break;
    }
    case isValues(field): {
      // NOTE: Tables are also used for storing constants - we should probably
      // store these separately...
      table.values = field.value.fields.filter(isTableField).map(toProperty);
      break;
    }
    case isType(field): {
      table.type = explicitlyMapType(JSON.parse(field.value.raw));
      break;
    }
    case isFields(field): {
      table.fields = field.value.fields.filter(isTableField).map(toProperty);
      break;
    }
    default:
      unhandledBranch(field);
  }

  return table;
}

export function toEvent(event: EventSignature, field: luaparse.TableKeyString) {
  switch (true) {
    case isName(field): {
      event.name = JSON.parse(field.value.raw);
      break;
    }
    case isLiteralName(field): {
      event.literalName = JSON.parse(field.value.raw);
      break;
    }
    case isType(field): {
      // Don't care
      // event.type = JSON.parse(field.value.raw);
      break;
    }
    case isDocumentation(field): {
      event.description = field.value.fields
        .filter(isTableValue)
        .map((v) => JSON.parse(v.value.raw))
        .join('\n');
      break;
    }
    case isPayload(field): {
      event.payload = field.value.fields.filter(isTableField).map(toProperty);
      break;
    }
    default:
      unhandledBranch(field);
  }

  return event;
}

function isStringLiteral(v: { type: string }): v is luaparse.StringLiteral {
  return v.type === 'StringLiteral';
}

function isBooleanLiteral(v: { type: string }): v is luaparse.BooleanLiteral {
  return v.type === 'BooleanLiteral';
}
function isNumericLiteral(v: { type: string }): v is luaparse.NumericLiteral {
  return v.type === 'NumericLiteral';
}
function isUnaryExpression(v: { type: string }): v is luaparse.UnaryExpression {
  return v.type === 'UnaryExpression';
}
function isMemberExpression(v: { type: string }): v is luaparse.MemberExpression {
  return v.type === 'MemberExpression';
}
function isIdentifier(v: { type: string }): v is luaparse.Identifier {
  return v.type === 'Identifier';
}
function isBinaryExpression(v: { type: string }): v is luaparse.BinaryExpression {
  return v.type === 'BinaryExpression';
}

function toLiteral(value: { type: string }): string | number | boolean | undefined {
  return match(value)
    .with(P.when(isStringLiteral), (v) => {
      if (typeof v.value === 'string') return v.value;
      if (v.raw) {
        try {
          return JSON.parse(v.raw);
        } catch {
          return v.raw.replace(/^['"]|['"]$/g, '');
        }
      }
      return undefined;
    })
    .with(P.when(isNumericLiteral), (v) => v.value)
    .with(P.when(isBooleanLiteral), (v) => v.value)
    .with(P.when(isUnaryExpression), (v) => {
      const sign = v.operator === '-' ? -1 : 1;

      if (isStringLiteral(v.argument)) {
        return `${sign}${v.argument.raw}`;
      }

      if (!isNumericLiteral(v.argument)) {
        return 0;
      }

      return sign * (JSON.parse(v.argument.raw) as number);
    })
    .with(P.when(isBinaryExpression), (v) => {
      const sign = match(v.operator)
        .with('-', () => -1)
        .otherwise(() => 1);
      const left = toLiteral(v.left);
      const right = toLiteral(v.right);
      if (
        typeof left === 'string' ||
        typeof right === 'string' ||
        typeof left === 'boolean' ||
        typeof right === 'boolean'
      ) {
        return `${left} ${v.operator} ${right}`;
      }

      if (typeof left === 'number' && typeof right === 'number') {
        return left + sign * right;
      }

      return undefined;
    })
    .otherwise(() => undefined);
}

export function toVariableSignature(parentType: string) {
  return (signature: VariableSignature, field: luaparse.TableKeyString) => {
    switch (true) {
      case isName(field): {
        if (parentType === 'Enumeration') {
          signature.name = JSON.parse(field.value.raw);
        } else {
          signature.name = camelCase(JSON.parse(field.value.raw)).replace('Afk', 'AFK');
        }
        break;
      }
      case isDefault(field): {
        if (field.value.type !== 'UnaryExpression') {
          signature.default = field.value.value || JSON.parse(field.value.raw);
        }
        break;
      }
      case isType(field): {
        signature.type = explicitlyMapType(JSON.parse(field.value.raw));
        break;
      }
      case isMixin(field): {
        signature.mixin = JSON.parse(field.value.raw);
        break;
      }
      case isStrideIndex(field): {
        signature.strideIndex = JSON.parse(field.value.raw);
        break;
      }
      case isDocumentation(field): {
        signature.description = field.value.fields
          .filter(isTableValue)
          .map((v) => JSON.parse(v.value.raw))
          .join('\n');
        break;
      }
      case isNilable(field): {
        signature.nilable = field.value.value;
        break;
      }
      case isValue(field) || isEnumValue(field): {
        signature.value = toLiteral(field.value);
        // This needs proper parsing... it can be a UnaryExpression - skip it for now...
        // A value can also be a constant reference - not supported for now
        break;
      }
      default:
        unhandledBranch(field);
    }

    return signature;
  };
}

export function isKeyValueField(
  field: luaparse.TableKey | luaparse.TableKeyString | luaparse.TableValue,
): field is luaparse.TableKeyString {
  return field.type === 'TableKeyString';
}
export function isName(
  field: luaparse.TableKeyString,
): field is luaparse.TableKeyString & { value: luaparse.StringLiteral } {
  return field.key.name === 'Name' && field.value.type === 'StringLiteral';
}
export function isLiteralName(
  field: luaparse.TableKeyString,
): field is luaparse.TableKeyString & { value: luaparse.StringLiteral } {
  return field.key.name === 'LiteralName' && field.value.type === 'StringLiteral';
}
export function isType(
  field: luaparse.TableKeyString,
): field is luaparse.TableKeyString & { value: luaparse.StringLiteral } {
  return (field.key.name === 'Type' || field.key.name === 'InnerType') && field.value.type === 'StringLiteral';
}
export function isDocumentation(
  field: luaparse.TableKeyString,
): field is luaparse.TableKeyString & { value: luaparse.TableConstructorExpression } {
  return field.key.name === 'Documentation' && field.value.type === 'TableConstructorExpression';
}
export function isEnumValue(field: luaparse.TableKeyString): field is luaparse.TableKeyString {
  return field.key.name === 'EnumValue';
}
export function isEnumRange(
  field: luaparse.TableKeyString,
): field is luaparse.TableKeyString & { value: luaparse.NumericLiteral } {
  return (
    ['MinValue', 'MaxValue', 'NumValues'].some((k) => k === field.key.name) &&
    (field.value.type === 'NumericLiteral' || field.value.type === 'UnaryExpression')
  );
}

export function isMixin(
  field: luaparse.TableKeyString,
): field is luaparse.TableKeyString & { value: luaparse.StringLiteral } {
  return field.key.name === 'Mixin' && field.value.type === 'StringLiteral';
}

export function isStrideIndex(
  field: luaparse.TableKeyString,
): field is luaparse.TableKeyString & { value: luaparse.NumericLiteral } {
  return field.key.name === 'StrideIndex' && field.value.type === 'NumericLiteral';
}

export function isDefault(field: luaparse.TableKeyString): field is luaparse.TableKeyString & {
  value: luaparse.StringLiteral | luaparse.NumericLiteral | luaparse.BooleanLiteral | luaparse.UnaryExpression;
} {
  return (
    field.key.name === 'Default' &&
    (field.value.type === 'StringLiteral' ||
      field.value.type === 'NumericLiteral' ||
      field.value.type === 'BooleanLiteral' ||
      field.value.type === 'UnaryExpression')
  );
}

export function isValue(field: luaparse.TableKeyString): field is luaparse.TableKeyString & {
  value:
    | luaparse.StringLiteral
    | luaparse.NumericLiteral
    | luaparse.BooleanLiteral
    | luaparse.UnaryExpression
    | luaparse.MemberExpression
    | luaparse.Identifier
    | luaparse.BinaryExpression;
} {
  return (
    field.key.name === 'Value' &&
    (field.value.type === 'StringLiteral' ||
      field.value.type === 'NumericLiteral' ||
      field.value.type === 'BooleanLiteral' ||
      field.value.type === 'UnaryExpression' ||
      field.value.type === 'MemberExpression' ||
      field.value.type === 'BinaryExpression' ||
      field.value.type === 'Identifier')
  );
}

export function isNilable(
  field: luaparse.TableKeyString,
): field is luaparse.TableKeyString & { value: luaparse.BooleanLiteral } {
  return field.key.name === 'Nilable' && field.value.type === 'BooleanLiteral';
}

export function isNamespace(
  field: luaparse.TableKeyString,
): field is luaparse.TableKeyString & { value: luaparse.StringLiteral } {
  return field.key.name === 'Namespace' && field.value.type === 'StringLiteral';
}

export function isFields(
  field: luaparse.TableKeyString,
): field is luaparse.TableKeyString & { value: luaparse.TableConstructorExpression } {
  return field.key.name === 'Fields' && field.value.type === 'TableConstructorExpression';
}
export function isPayload(
  field: luaparse.TableKeyString,
): field is luaparse.TableKeyString & { value: luaparse.TableConstructorExpression } {
  return field.key.name === 'Payload' && field.value.type === 'TableConstructorExpression';
}

export function isFunctionList(field: luaparse.TableKeyString): field is luaparse.TableKeyString & {
  value: luaparse.TableConstructorExpression;
} {
  return field.key.name === 'Functions' && field.value.type === 'TableConstructorExpression';
}

export function isTableList(field: luaparse.TableKeyString): field is luaparse.TableKeyString & {
  value: luaparse.TableConstructorExpression;
} {
  return field.key.name === 'Tables' && field.value.type === 'TableConstructorExpression';
}

export function isEventList(field: luaparse.TableKeyString): field is luaparse.TableKeyString & {
  value: luaparse.TableConstructorExpression;
} {
  return field.key.name === 'Events' && field.value.type === 'TableConstructorExpression';
}

export function isTableField(
  field: luaparse.TableKey | luaparse.TableKeyString | luaparse.TableValue,
): field is TableField {
  return field.type === 'TableValue' && field.value.type === 'TableConstructorExpression';
}

export function isTableValue(
  field: luaparse.TableKey | luaparse.TableKeyString | luaparse.TableValue,
): field is TableValue & {
  value: luaparse.StringLiteral;
} {
  return field.type === 'TableValue' && field.value.type === 'StringLiteral';
}

export function isParameters(field: luaparse.TableKeyString): field is luaparse.TableKeyString & {
  value: luaparse.TableConstructorExpression;
} {
  return field.key.name === 'Arguments' && field.value.type === 'TableConstructorExpression';
}

export function isValues(field: luaparse.TableKeyString): field is luaparse.TableKeyString & {
  value: luaparse.TableConstructorExpression;
} {
  return field.key.name === 'Values' && field.value.type === 'TableConstructorExpression';
}

export function isReturns(field: luaparse.TableKeyString): field is luaparse.TableKeyString & {
  value: luaparse.TableConstructorExpression;
} {
  return field.key.name === 'Returns' && field.value.type === 'TableConstructorExpression';
}
