import { useEffect, useState } from 'react';
import { useConsoleConfig, type OriginUserProfile } from '../config';

// One lookup per distinct email for the life of the page. The map holds either
// a settled profile (or null for "no match / resolver failed") or the in-flight
// promise, so concurrent nodes for the same user share a single resolver call.
const cache = new Map<string, OriginUserProfile | null | Promise<OriginUserProfile | null>>();

/**
 * Resolve an origin email to a display profile via the host-injected
 * `config.userResolver`. Returns null while unresolved, when there is no
 * resolver, and when the resolver has nothing for this email.
 */
export function useOriginUser(email?: string | null): OriginUserProfile | null {
  const { userResolver } = useConsoleConfig();

  const settled = email ? cache.get(email) : undefined;
  const [profile, setProfile] = useState<OriginUserProfile | null>(
    settled !== undefined && !(settled instanceof Promise) ? settled : null,
  );

  useEffect(() => {
    if (!email || !userResolver) return;
    const hit = cache.get(email);
    if (hit !== undefined && !(hit instanceof Promise)) {
      setProfile(hit);
      return;
    }
    let alive = true;
    const promise =
      hit instanceof Promise
        ? hit
        : Promise.resolve()
            .then(() => userResolver(email))
            .then(value => value ?? null)
            .catch(() => null)
            .then(value => {
              cache.set(email, value);
              return value;
            });
    if (hit === undefined) cache.set(email, promise);
    promise.then(value => {
      if (alive) setProfile(value);
    });
    return () => {
      alive = false;
    };
  }, [email, userResolver]);

  return profile;
}

export default useOriginUser;
