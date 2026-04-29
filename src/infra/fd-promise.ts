import fs from "node:fs";

/**
 * `fs.promises.readFile` typings only accept `PathLike | FileHandle`, but the
 * callback `fs.readFile` API accepts a numeric file descriptor. Use this helper
 * when holding an fd from a verified open path.
 */
export function readFileUtf8FromFd(fd: number): Promise<string> {
  return new Promise((resolve, reject) => {
    fs.readFile(fd, { encoding: "utf8" }, (err, data) => {
      if (err) {
        reject(err);
        return;
      }
      resolve(data);
    });
  });
}

/**
 * Read raw bytes from a verified numeric file descriptor.
 */
export function readFileBufferFromFd(fd: number): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    fs.readFile(fd, (err, data) => {
      if (err) {
        reject(err);
        return;
      }
      resolve(data);
    });
  });
}

/**
 * `fs.promises` does not expose `close` for raw fds; use the callback API.
 */
export function closeFileDescriptorAsync(fd: number): Promise<void> {
  return new Promise((resolve, reject) => {
    fs.close(fd, (err) => {
      if (err) {
        reject(err);
        return;
      }
      resolve();
    });
  });
}
