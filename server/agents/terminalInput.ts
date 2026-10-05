/** Let interactive CLIs finish handling a bracketed paste before submitting it. */
export function terminalInput(write: (data: string) => void) {
  const pending: string[] = [];
  let timer: ReturnType<typeof setTimeout> | undefined;
  let closed = false;

  function flush() {
    while (!timer && pending.length && !closed) {
      const data = pending.shift()!;
      const end = data.indexOf('\x1b[201~');
      const split = end + '\x1b[201~'.length;
      if (end >= 0) {
        write(data.slice(0, split));
        if (data.length > split) pending.unshift(data.slice(split));
        timer = setTimeout(() => {
          timer = undefined;
          flush();
        }, 500);
      } else {
        write(data);
      }
    }
  }

  return {
    write(data: string) {
      if (closed) return false;
      pending.push(data);
      flush();
      return true;
    },
    close() {
      closed = true;
      if (timer) clearTimeout(timer);
      pending.length = 0;
    },
  };
}
