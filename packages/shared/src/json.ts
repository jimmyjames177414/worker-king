/** A JSON-serializable value. Used for tool-call args/results crossing the bus. */
export type JsonValue =
  | string
  | number
  | boolean
  | null
  | JsonValue[]
  | { [key: string]: JsonValue };
