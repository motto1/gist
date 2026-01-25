export const cleanString = (input: string): string => {
  return input
    .replace(/\u0000/g, '')
    .replace(/\r\n|\n|\r/gm, ' ')
    .replace(/\s\s+/g, ' ')
    .trim()
}

export const truncateCenterString = (input: string, maxLength: number): string => {
  if (maxLength <= 0) return ''
  if (input.length <= maxLength) return input
  const half = Math.floor((maxLength - 3) / 2)
  return `${input.slice(0, half)}...${input.slice(input.length - half)}`
}

export const isHttpUrl = (value: string): boolean => {
  return /^https?:\/\//i.test(value)
}

