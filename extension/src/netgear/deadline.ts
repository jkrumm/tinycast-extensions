// A hard time limit for one awaited step — pure, no `@raycast/api`. Real
// timers on purpose: it guards against a step that never settles (a hung
// `networksetup`, a curl that outlives its `-m`), which an injected fake
// `sleep` cannot model. The abandoned promise keeps running; its late result
// or rejection is ignored.
export function withDeadline<T>(
  promise: Promise<T>,
  ms: number,
  onTimeout: () => T,
): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => resolve(onTimeout()), ms);
    promise.then(
      (value) => {
        clearTimeout(timer);
        resolve(value);
      },
      (error) => {
        clearTimeout(timer);
        reject(error);
      },
    );
  });
}
