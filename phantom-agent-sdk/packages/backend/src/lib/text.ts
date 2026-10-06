/** The string an unknown value stands for: a string as it is; a number,
 *  boolean or bigint printed; anything else — null, undefined, an object,
 *  an array — ''. THE way a value from outside (a tool argument, a request
 *  header, a JSON column) becomes text: never '[object Object]'. */
export function textOf(value: unknown): string {
  switch (typeof value) {
    case 'string': return value;
    case 'number': case 'boolean': case 'bigint': return String(value);
    default: return '';
  }
}
