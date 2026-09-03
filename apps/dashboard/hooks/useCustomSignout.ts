import { useRouter } from 'next/router';
import { signOut as nextAuthSignOut } from 'next-auth/react';

export function useCustomSignOut() {
  const router = useRouter();

  const signOut = async () => {
    try {
      const response = await fetch('/api/auth/custom-signout', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
        },
      });

      if (!response.ok) {
        throw new Error('Signout failed');
      }

      // [RELAY-112] REAL bug, found running the consumer-journey E2E suite for
      // real (not from reading the code): the server-side cookie clear above was
      // always correct — a real browser check confirmed the session cookie is
      // genuinely gone immediately after this call — but `next-auth/react`'s
      // `SessionProvider` (wrapping the whole app in `_app.tsx`) keeps its OWN
      // client-side cache of `status`/`session`, and that cache is only
      // invalidated by NextAuth's OWN `signOut()`/`signIn()` calls, a window
      // focus, or its periodic refetch — never by an unrelated `fetch()` to a
      // custom API route. Calling only the custom endpoint left every
      // `useSession()` consumer (starting with `pages/auth/login.tsx`, which
      // redirects to `redirectUrl` on literally every render where
      // `status === 'authenticated'`) still believing the user was signed in.
      // The result, reproduced directly: the client-side `router.push('/auth/
      // login')` below landed on the login page, which immediately bounced back
      // to `/dashboard` from stale client state — `/dashboard` then 307'd back to
      // `/auth/login` server-side (the cookie really is gone, so middleware
      // correctly refuses it) — an infinite bounce with NO session cookie present
      // at any point, confirmed via `page.context().cookies()` throughout.
      //
      // `signOut({ redirect: false })` is `next-auth/react`'s own, correct way to
      // both end the session AND synchronize every `useSession()` consumer's
      // cached state — `redirect: false` because this hook already owns
      // navigation via `router.push` below, and needs the CLIENT session state
      // resolved before that navigation happens, not a `next-auth`-driven
      // redirect racing it. This is a second, redundant cookie-clear on the wire
      // (harmless — the cookie is already gone) purely for the client-cache sync
      // side effect, which is the part the custom endpoint alone cannot provide.
      await nextAuthSignOut({ redirect: false });

      router.push('/auth/login');
    } catch (error) {
      console.error('Error during sign out:', error);
    }
  };

  return signOut;
}
