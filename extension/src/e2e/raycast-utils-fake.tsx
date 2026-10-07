// A fake `@raycast/utils`, aliased alongside raycast-fake.tsx (see
// AGENTS.md § End-to-end render harness). Real `@raycast/utils` hooks import
// `@raycast/api` internally (its own `Cache`, for one) — aliasing this whole
// package sidesteps needing that to line up with our fake, and gives the
// render harness real effect-driven semantics (useState/useEffect) so a
// component's data-loading behaves like it does in Tinycast, including
// running the effect that fetches on mount — the harness's whole point.
import { useCallback, useEffect, useRef, useState } from "react";

interface AsyncState<T> {
  data: T | undefined;
  error: unknown;
  isLoading: boolean;
}

interface PromiseOptions<T> {
  keepPreviousData?: boolean;
  execute?: boolean;
  onError?: (error: unknown) => void;
  onData?: (data: T) => void;
}

interface PromiseResult<T> extends AsyncState<T> {
  revalidate: () => void;
  mutate: (
    asyncUpdate?: Promise<unknown>,
    options?: {
      optimisticUpdate?: (current: T | undefined) => T;
      shouldRevalidateAfter?: boolean;
    },
  ) => Promise<void>;
}

// Shared by useCachedPromise/usePromise — both differ from real
// @raycast/utils only in caching-across-command-launches, which this
// in-process test harness has no notion of anyway.
function usePromiseLike<T, Args extends unknown[]>(
  fn: (...args: Args) => Promise<T>,
  args: Args,
  options?: PromiseOptions<T>,
): PromiseResult<T> {
  const [state, setState] = useState<AsyncState<T>>({
    data: undefined,
    error: undefined,
    isLoading: options?.execute !== false,
  });
  const fnRef = useRef(fn);
  fnRef.current = fn;
  const optionsRef = useRef(options);
  optionsRef.current = options;

  const revalidate = useCallback(() => {
    if (optionsRef.current?.execute === false) return;
    setState((s) => ({
      data: optionsRef.current?.keepPreviousData ? s.data : undefined,
      error: undefined,
      isLoading: true,
    }));
    fnRef
      .current(...args)
      .then((data) => {
        optionsRef.current?.onData?.(data);
        setState({ data, error: undefined, isLoading: false });
      })
      .catch((error: unknown) => {
        optionsRef.current?.onError?.(error);
        setState((s) => ({
          data: optionsRef.current?.keepPreviousData ? s.data : undefined,
          error,
          isLoading: false,
        }));
      });
    // `args` is the caller-controlled dependency tuple by design — this
    // helper's whole job is re-running `fn` when it changes.
  }, args);

  useEffect(() => {
    revalidate();
  }, args);

  const mutate = useCallback(
    async (
      _asyncUpdate?: Promise<unknown>,
      mutateOptions?: {
        optimisticUpdate?: (current: T | undefined) => T;
        shouldRevalidateAfter?: boolean;
      },
    ) => {
      if (mutateOptions?.optimisticUpdate) {
        setState((s) => ({
          ...s,
          data: mutateOptions.optimisticUpdate!(s.data),
        }));
      }
      if (mutateOptions?.shouldRevalidateAfter !== false) revalidate();
    },
    [revalidate],
  );

  return { ...state, revalidate, mutate };
}

export function useCachedPromise<T, Args extends unknown[] = []>(
  fn: (...args: Args) => Promise<T>,
  args: Args = [] as unknown as Args,
  options?: PromiseOptions<T>,
): PromiseResult<T> {
  return usePromiseLike(fn, args, options);
}

export function usePromise<T, Args extends unknown[] = []>(
  fn: (...args: Args) => Promise<T>,
  args: Args = [] as unknown as Args,
  options?: PromiseOptions<T>,
): PromiseResult<T> {
  return usePromiseLike(fn, args, options);
}

export function useFetch<T>(
  url: string,
  options?: PromiseOptions<T> & { headers?: Record<string, string> },
): PromiseResult<T> {
  return usePromiseLike(
    async () => {
      const res = await fetch(url, { headers: options?.headers });
      if (!res.ok) throw new Error(`${res.status}: ${await res.text()}`);
      return (await res.json()) as T;
    },
    [] as unknown[] as [],
    options,
  );
}
