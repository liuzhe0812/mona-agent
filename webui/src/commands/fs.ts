import { invoke } from "@tauri-apps/api/core"
import type { FileNode } from "@/types/wiki"

export async function readFile(path: string): Promise<string> {
  return invoke<string>("read_file", { path })
}

export async function writeFile(path: string, contents: string): Promise<void> {
  return invoke<void>("write_file", { path, contents })
}

export async function writeFileAtomic(path: string, contents: string): Promise<void> {
  return invoke<void>("write_file_atomic", { path, contents })
}

export async function listDirectory(path: string): Promise<FileNode[]> {
  return invoke<FileNode[]>("list_directory", { path })
}

export async function copyFile(
  source: string,
  destination: string
): Promise<void> {
  return invoke("copy_file", { source, destination })
}

export async function copyDirectory(
  source: string,
  destination: string
): Promise<string[]> {
  return invoke<string[]>("copy_directory", { source, destination })
}

export async function preprocessFile(path: string): Promise<string> {
  return invoke<string>("preprocess_file", { path })
}

export async function deleteFile(path: string): Promise<void> {
  return invoke("delete_file", { path })
}

export async function createDirectory(path: string): Promise<void> {
  return invoke<void>("create_directory", { path })
}

export async function fileExists(path: string): Promise<boolean> {
  return invoke<boolean>("file_exists", { path })
}

export async function getFileModifiedTime(path: string): Promise<number> {
  return invoke<number>("get_file_modified_time", { path })
}

export async function getFileSize(path: string): Promise<number> {
  return invoke<number>("get_file_size", { path })
}
