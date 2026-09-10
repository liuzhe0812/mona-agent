export interface PickedImage {
  base64: string
  mime: 'image/png' | 'image/jpeg' | 'image/gif'
  name: string
}

export function pickBrowserImage(): Promise<PickedImage | null> {
  return new Promise((resolve) => {
    const input = document.createElement('input')
    input.type = 'file'
    input.accept = 'image/png,image/jpeg,image/gif'
    input.hidden = true
    input.addEventListener('change', () => {
      const file = input.files?.[0]
      if (!file || !['image/png', 'image/jpeg', 'image/gif'].includes(file.type)) {
        input.remove()
        resolve(null)
        return
      }
      const reader = new FileReader()
      reader.addEventListener('load', () => {
        input.remove()
        const value = typeof reader.result === 'string' ? reader.result : ''
        resolve(value ? {
          base64: value.slice(value.indexOf(',') + 1),
          mime: file.type as PickedImage['mime'],
          name: file.name,
        } : null)
      })
      reader.addEventListener('error', () => {
        input.remove()
        resolve(null)
      })
      reader.readAsDataURL(file)
    }, { once: true })
    document.body.append(input)
    input.click()
  })
}
