declare module 'bidi-js' {
  export default function bidiFactory(): {
    getEmbeddingLevels(text: string): { levels: Uint8Array }
  }
}
