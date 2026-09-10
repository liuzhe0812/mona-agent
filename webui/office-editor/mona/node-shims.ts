function unavailable(): never {
  throw new Error('Mona 编辑器不支持 Node 文件接口。')
}

export const createHash = unavailable
export const randomUUID = () => crypto.randomUUID()
export const closeSync = unavailable
export const fsyncSync = unavailable
export const openSync = unavailable
export const readFileSync = unavailable
export const writeFileSync = unavailable
export const rename = unavailable
export const rm = unavailable
export const dirname = unavailable
export const join = unavailable
export const pipeline = unavailable
export const deflateRawSync = unavailable
export const deflateSync = unavailable
export const inflateRawSync = unavailable
