import { useEffect, useState } from 'react'

/**
 * Whether a CSS media query matches right now, kept current on resize.
 *
 * Used where responsive hiding must be deterministic. Pairing a base display
 * class with a breakpoint display class (`hidden max-[900px]:inline`) leaves
 * the winner to stylesheet order, which is how a menu can stay invisible at
 * exactly the width it was built for - conditional rendering has no such
 * ambiguity, at the cost of a re-render on window resize.
 */
export function useMediaQuery(query: string): boolean {
  const [matches, setMatches] = useState<boolean>(() =>
    typeof window === 'undefined' ? false : window.matchMedia(query).matches
  )

  useEffect(() => {
    const list = window.matchMedia(query)
    const onChange = (): void => setMatches(list.matches)
    onChange()
    list.addEventListener('change', onChange)
    return () => list.removeEventListener('change', onChange)
  }, [query])

  return matches
}
