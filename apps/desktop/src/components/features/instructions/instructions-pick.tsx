import { Navigate, useParams } from "@tanstack/react-router";

/**
 * Instructions with nothing open: everything Claude reads, in order — where a
 * conversation starts too (FE-37/D4).
 */
export function InstructionsPick() {
  const { slug } = useParams({ from: "/_app/w/$slug/instructions/" });
  return (
    <Navigate
      to="/w/$slug/instructions/effective/$agent"
      params={{ slug, agent: "claude" }}
      replace
    />
  );
}
