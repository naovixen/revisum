// A small JSON Schema (2020-12) validator for the keywords the plan language's schema uses, so the
// schema check needs no third-party package. A keyword it does not know is reported as a problem
// rather than ignored, so the schema cannot quietly rely on a rule nothing checks.
// See docs/specs/SPEC-01-plan-language-and-parser.md.
import { isDeepStrictEqual } from 'node:util';

type SchemaObject = Readonly<Record<string, unknown>>;

// Keywords that describe rather than constrain.
const ANNOTATIONS = new Set(['$schema', '$id', '$defs', '$comment', 'title', 'description']);

const isObject = (value: unknown): value is SchemaObject =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

function hasType(value: unknown, type: unknown): boolean {
  switch (type) {
    case 'object': return isObject(value);
    case 'array': return Array.isArray(value);
    case 'string': return typeof value === 'string';
    case 'integer': return typeof value === 'number' && Number.isInteger(value);
    case 'number': return typeof value === 'number' && Number.isFinite(value);
    case 'boolean': return typeof value === 'boolean';
    case 'null': return value === null;
    default: return false;
  }
}

const describe = (value: unknown): string => (Array.isArray(value) ? 'array' : value === null ? 'null' : typeof value);

// Every way `value` breaks `schema`, each as "<JSON path>: <problem>". Empty means it validates.
export function validateAgainstSchema(schema: unknown, value: unknown): string[] {
  const root = schema;

  const resolve = (reference: unknown, path: string): unknown => {
    const prefix = '#/$defs/';
    if (typeof reference !== 'string' || !reference.startsWith(prefix)) throw new Error(`${path}: unsupported $ref ${String(reference)}`);
    const definitions = isObject(root) ? root['$defs'] : undefined;
    const target = isObject(definitions) ? definitions[reference.slice(prefix.length)] : undefined;
    if (target === undefined) throw new Error(`${path}: $ref ${reference} names no definition`);
    return target;
  };

  const validate = (node: unknown, instance: unknown, path: string): string[] => {
    if (!isObject(node)) return [`${path}: the schema at this point is not an object`];
    const problems: string[] = [];
    for (const [keyword, rule] of Object.entries(node)) {
      if (ANNOTATIONS.has(keyword)) continue;
      switch (keyword) {
        case '$ref': problems.push(...validate(resolve(rule, path), instance, path)); break;
        case 'type': if (!hasType(instance, rule)) problems.push(`${path}: expected ${String(rule)}, found ${describe(instance)}`); break;
        case 'const': if (!isDeepStrictEqual(instance, rule)) problems.push(`${path}: is not the required constant`); break;
        case 'enum': if (!Array.isArray(rule) || !rule.some((allowed) => isDeepStrictEqual(instance, allowed))) problems.push(`${path}: is not one of the allowed values`); break;
        case 'pattern': if (typeof instance === 'string' && !new RegExp(String(rule), 'u').test(instance)) problems.push(`${path}: does not match the required pattern`); break;
        case 'minLength': if (typeof instance === 'string' && [...instance].length < Number(rule)) problems.push(`${path}: is shorter than ${String(rule)} characters`); break;
        case 'maxLength': if (typeof instance === 'string' && [...instance].length > Number(rule)) problems.push(`${path}: is longer than ${String(rule)} characters`); break;
        case 'minimum': if (typeof instance === 'number' && instance < Number(rule)) problems.push(`${path}: is below ${String(rule)}`); break;
        case 'maximum': if (typeof instance === 'number' && instance > Number(rule)) problems.push(`${path}: is above ${String(rule)}`); break;
        case 'minItems': if (Array.isArray(instance) && instance.length < Number(rule)) problems.push(`${path}: has fewer than ${String(rule)} items`); break;
        case 'maxItems': if (Array.isArray(instance) && instance.length > Number(rule)) problems.push(`${path}: has more than ${String(rule)} items`); break;
        case 'uniqueItems':
          if (rule === true && Array.isArray(instance) && instance.some((item, index) => instance.findIndex((other) => isDeepStrictEqual(item, other)) !== index)) {
            problems.push(`${path}: has repeated items`);
          }
          break;
        case 'items':
          if (Array.isArray(instance)) instance.forEach((item, index) => problems.push(...validate(rule, item, `${path}[${index}]`)));
          break;
        case 'properties':
          if (isObject(instance) && isObject(rule)) {
            for (const [name, propertySchema] of Object.entries(rule)) {
              if (Object.hasOwn(instance, name)) problems.push(...validate(propertySchema, instance[name], `${path}.${name}`));
            }
          }
          break;
        case 'required':
          if (isObject(instance) && Array.isArray(rule)) {
            for (const name of rule) if (!Object.hasOwn(instance, String(name))) problems.push(`${path}: is missing the required property ${String(name)}`);
          }
          break;
        case 'additionalProperties': {
          // false refuses every property not declared; a schema checks each of them against it.
          if (rule !== false && !isObject(rule)) { problems.push(`${path}: "additionalProperties" must be false or a schema`); break; }
          if (!isObject(instance)) break;
          const declared = isObject(node['properties']) ? node['properties'] : {};
          for (const name of Object.keys(instance).filter((key) => !Object.hasOwn(declared, key))) {
            if (rule === false) problems.push(`${path}: has the unknown property ${name}`);
            else problems.push(...validate(rule, instance[name], `${path}.${name}`));
          }
          break;
        }
        case 'propertyNames':
          if (isObject(instance)) {
            for (const name of Object.keys(instance)) {
              if (validate(rule, name, path).length > 0) problems.push(`${path}: has a property whose name is not allowed`);
            }
          }
          break;
        case 'oneOf': {
          if (!Array.isArray(rule)) { problems.push(`${path}: oneOf is not a list`); break; }
          const outcomes = rule.map((alternative) => validate(alternative, instance, path));
          const matching = outcomes.filter((outcome) => outcome.length === 0).length;
          if (matching === 1) break;
          if (matching > 1) { problems.push(`${path}: matches more than one of the allowed shapes`); break; }
          // Name the closest shape's first problem, so the message points at the actual mistake.
          const closest = outcomes.reduce((best, outcome) => (outcome.length < best.length ? outcome : best));
          problems.push(`${path}: matches none of the allowed shapes${closest[0] === undefined ? '' : `; closest: ${closest[0]}`}`);
          break;
        }
        default: problems.push(`${path}: the validator does not support the keyword ${keyword}`);
      }
    }
    return problems;
  };

  return validate(schema, value, '$');
}
