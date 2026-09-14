interface SerialPort {
  readable: ReadableStream<Uint8Array> | null
  writable: WritableStream<Uint8Array> | null
  open(options: { baudRate: number }): Promise<void>
  close(): Promise<void>
}

interface Serial {
  requestPort(): Promise<SerialPort>
}

interface Navigator {
  serial: Serial
}

interface Window {
  showDirectoryPicker?: () => Promise<FileSystemDirectoryHandle>
}

interface FileSystemDirectoryHandle {
  name: string
  getFileHandle(name: string, options?: { create?: boolean }): Promise<FileSystemFileHandle>
}

interface FileSystemFileHandle {
  createWritable(): Promise<FileSystemWritableFileStream>
}

interface FileSystemWritableFileStream {
  write(data: string): Promise<void>
  close(): Promise<void>
}
