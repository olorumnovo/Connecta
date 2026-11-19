"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import type { ApiResult } from "@/types/api";

const inFlightRequests = new Map<string, Promise<{ response: Response; body: string }>>();

function requestOnce(url: string) {
  const existing = inFlightRequests.get(url);
  if (existing) return existing;
  const request = fetch(url, { cache: "no-cache" })
    .then(async (response) => ({ response, body: await response.text() }))
    .finally(() => window.setTimeout(() => inFlightRequests.delete(url), 250));
  inFlightRequests.set(url, request);
  return request;
}

export function useApiResource<T>(url: string, enabled = true) {
  const hasData = useRef(false);
  const requestVersion = useRef(0);
  const [data, setData] = useState<T | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const refresh = useCallback(async () => {
    if (!enabled) return;
    const version = ++requestVersion.current;
    setLoading(!hasData.current);
    setError(null);
    try {
      const { response, body } = await requestOnce(url);
      if (version !== requestVersion.current) return;

      if (!body.trim()) {
        setError(response.ok ? "O servidor retornou uma resposta vazia." : `Falha na consulta (${response.status}).`);
        return;
      }

      let result: ApiResult<T>;
      try {
        result = JSON.parse(body) as ApiResult<T>;
      } catch {
        setError(`O servidor retornou uma resposta inválida (${response.status}).`);
        return;
      }

      if (response.ok && result.status === "success") {
        hasData.current = true;
        setData(result.data);
      } else {
        setError(result.message || `Falha na consulta (${response.status}).`);
      }
    } catch (requestError) {
      if (version !== requestVersion.current) return;
      setError(requestError instanceof Error ? requestError.message : "Não foi possível consultar o servidor.");
    } finally {
      if (version === requestVersion.current) setLoading(false);
    }
  }, [url, enabled]);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  return { data, loading, error, refresh };
}
