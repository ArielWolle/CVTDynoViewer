// File System Access API ambient types -- not included in TypeScript's bundled "DOM" lib.
// (Web Serial declarations formerly here moved out entirely; see usb.d.ts for the WebUSB
// declarations that replaced them as the device transport.)

interface Window {
  showDirectoryPicker?: () => Promise<FileSystemDirectoryHandle>
}

interface FileSystemDirectoryHandle {
  name: string
  getFileHandle(name: string, options?: { create?: boolean }): Promise<FileSystemFileHandle>
}

interface FileSystemFileHandle {
  getFile(): Promise<File>
  createWritable(options?: { keepExistingData?: boolean }): Promise<FileSystemWritableFileStream>
}

interface FileSystemWritableFileStream {
  write(data: string): Promise<void>
  seek(position: number): Promise<void>
  close(): Promise<void>
}
