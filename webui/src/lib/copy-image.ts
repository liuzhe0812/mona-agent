async function loadPng(url: string): Promise<Blob> {
  const response = await fetch(url);
  if (!response.ok) throw new Error(`Image request failed: ${response.status}`);
  const imageBlob = await response.blob();
  if (imageBlob.type.split(";", 1)[0].trim().toLowerCase() === "image/png") {
    return imageBlob.type === "image/png" ? imageBlob : imageBlob.slice(0, imageBlob.size, "image/png");
  }

  const objectUrl = URL.createObjectURL(imageBlob);
  try {
    const image = new Image();
    await new Promise<void>((resolve, reject) => {
      image.onload = () => resolve();
      image.onerror = () => reject(new Error("Image decoding failed"));
      image.src = objectUrl;
    });
    if (!image.naturalWidth || !image.naturalHeight) throw new Error("Invalid image dimensions");

    const canvas = document.createElement("canvas");
    canvas.width = image.naturalWidth;
    canvas.height = image.naturalHeight;
    const context = canvas.getContext("2d");
    if (!context) throw new Error("Image conversion unavailable");
    context.drawImage(image, 0, 0);
    return await new Promise<Blob>((resolve, reject) => {
      canvas.toBlob((converted) => {
        if (converted) resolve(converted);
        else reject(new Error("Image conversion failed"));
      }, "image/png");
    });
  } finally {
    URL.revokeObjectURL(objectUrl);
  }
}

export async function copyImageToClipboard(url: string): Promise<void> {
  if (!navigator.clipboard?.write || typeof ClipboardItem === "undefined") {
    throw new Error("Image clipboard unavailable");
  }

  const png = loadPng(url);
  // A denied clipboard write may finish before the pending image request.
  void png.catch(() => undefined);
  await navigator.clipboard.write([new ClipboardItem({ "image/png": png })]);
}
