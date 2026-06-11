declare module "@sglkc/kuromoji" {
  interface BuilderOption {
    dicPath: string;
  }
  interface Token {
    surface_form: string;
    reading?: string;
    pos?: string;
    basic_form?: string;
  }
  interface Tokenizer {
    tokenize(text: string): Token[];
  }
  interface Builder {
    build(callback: (err: unknown, tokenizer: Tokenizer) => void): void;
  }
  interface Kuromoji {
    builder(option: BuilderOption): Builder;
  }
  const kuromoji: Kuromoji;
  export default kuromoji;
}
