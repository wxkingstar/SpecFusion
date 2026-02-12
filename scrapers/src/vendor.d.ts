declare module 'swagger2openapi' {
  interface ConvertOptions {
    patch?: boolean;
    warnOnly?: boolean;
  }
  interface ConvertResult {
    openapi: unknown;
  }
  export function convertObj(
    swagger: unknown,
    options: ConvertOptions,
  ): Promise<ConvertResult>;
}

declare module 'html-to-markdown' {
  const converter: {
    convert(html: string): string;
  };
  export default converter;
}
