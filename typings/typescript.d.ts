declare module "pdfform.js/minipdf" {
  export interface Ref {}

  export function parse(buf: Uint8Array): PDFDocument;
  export function isName(obj: any): boolean;
  export function isStream(obj: any): boolean;
  export function isDict(obj: any): boolean;
  export function isRef(obj: any): boolean;
  export function isNum(obj: any): boolean;
  export function isArray(obj: any): boolean;
  export function isString(obj: any): boolean;
  export function isBool(obj: any): boolean;

  export function newStream(map: any, content: Uint8Array): Stream;
  export function assert(x: any, msg: string): void;
  export function buf2str(buf: Uint8Array, from?: number, to?: number): string;
  export function str2buf(s: string): Uint8Array;

  export class PDFDocument {
    constructor(buf);
    get_root_id(): any;
    get_xref_entries(): any;
    get_acroform_ref(): any;
    fetch(ref: Ref, recursive: boolean): any;
  }

  export class Stream {
    constructor(map: any, content: Uint8Array);
    getBytes(): Uint8Array;
  }
}

declare module "pdfform.js" {
  export type FieldType = "string" | "boolean" | "select";
  export interface Field {
    type: FieldType;
    options?: any;
  }

  export type FieldMap = Record<string, Field>;

  export interface PDFForms {
    transform(buf: Uint8Array, fields);
    list_fields(data: any): FieldMap;
  }

  export function pdfform(minipdf?: minipdf): PDFForms;
}
