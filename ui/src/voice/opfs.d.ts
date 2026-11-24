// OPFS sync access handles (worker only), missing from the DOM typings this project uses.
interface FileSystemSyncAccessHandle {
  getSize(): number;
  read(buffer: Uint8Array, options?: { at: number }): number;
  write(buffer: Uint8Array, options?: { at: number }): number;
  truncate(newSize: number): void;
  flush(): void;
  close(): void;
}

interface FileSystemFileHandle {
  createSyncAccessHandle(): Promise<FileSystemSyncAccessHandle>;
}
