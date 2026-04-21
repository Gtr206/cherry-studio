import type { TranslateLanguage } from '@renderer/types'
import { fireEvent, render, screen } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'

import LanguagePicker from '../LanguagePicker'

const english: TranslateLanguage = { value: 'English', langCode: 'en-us', label: () => 'English', emoji: '🇬🇧' }
const chinese: TranslateLanguage = { value: 'Chinese', langCode: 'zh-cn', label: () => 'Chinese', emoji: '🇨🇳' }
const japanese: TranslateLanguage = { value: 'Japanese', langCode: 'ja-jp', label: () => 'Japanese', emoji: '🇯🇵' }
const unknown: TranslateLanguage = { value: 'Unknown', langCode: 'unknown', label: () => 'Unknown', emoji: '🏳️' }

const allLanguages: TranslateLanguage[] = [english, chinese, japanese, unknown]

const mockUseTranslate = vi.fn()

vi.mock('@renderer/hooks/useTranslate', () => ({
  default: () => mockUseTranslate()
}))

vi.mock('@renderer/config/translate', () => ({
  UNKNOWN: { value: 'Unknown', langCode: 'unknown', label: () => 'Unknown', emoji: '🏳️' }
}))

vi.mock(import('@cherrystudio/ui'), async (importOriginal) => {
  const actual = await importOriginal()
  const { createContext, use, cloneElement, isValidElement } = await import('react')
  type Ctx = { open: boolean; onOpenChange: (next: boolean) => void }
  const PopoverCtx = createContext<Ctx>({ open: false, onOpenChange: () => {} })

  const Popover = ({
    children,
    open,
    onOpenChange
  }: {
    children: React.ReactNode
    open: boolean
    onOpenChange: (next: boolean) => void
  }) => <PopoverCtx value={{ open, onOpenChange }}>{children}</PopoverCtx>

  const PopoverTrigger = ({ children, asChild }: { children: React.ReactNode; asChild?: boolean }) => {
    const { open, onOpenChange } = use(PopoverCtx)
    const toggle = () => onOpenChange(!open)
    if (asChild && isValidElement(children)) {
      const child = children as React.ReactElement<{ onClick?: (e: React.MouseEvent) => void }>
      return cloneElement(child, {
        onClick: (e: React.MouseEvent) => {
          child.props.onClick?.(e)
          toggle()
        }
      })
    }
    return (
      <button type="button" onClick={toggle}>
        {children}
      </button>
    )
  }

  const PopoverContent = ({ children }: { children: React.ReactNode }) => {
    const { open } = use(PopoverCtx)
    return open ? <div data-testid="popover-content">{children}</div> : null
  }

  return { ...actual, Popover, PopoverTrigger, PopoverContent }
})

describe('LanguagePicker', () => {
  beforeEach(() => {
    mockUseTranslate.mockReset()
    mockUseTranslate.mockReturnValue({
      translateLanguages: allLanguages,
      getLanguageByLangcode: (code: string) => allLanguages.find((l) => l.langCode === code) ?? unknown
    })
  })

  it('renders selected language emoji and label in trigger', () => {
    render(<LanguagePicker value="en-us" onChange={vi.fn()} />)
    const trigger = screen.getByRole('button', { expanded: false })
    expect(trigger.textContent).toContain('English')
    expect(trigger.textContent).toContain('🇬🇧')
  })

  it('opens listbox on trigger click and excludes UNKNOWN', () => {
    render(<LanguagePicker value="en-us" onChange={vi.fn()} />)
    fireEvent.click(screen.getByRole('button', { expanded: false }))

    const listbox = screen.getByRole('listbox')
    const options = screen.getAllByRole('option')
    expect(listbox).toBeInTheDocument()
    expect(options).toHaveLength(3) // english, chinese, japanese — no UNKNOWN
    expect(listbox.textContent).not.toContain('Unknown')
  })

  it('calls onChange with selected langCode and closes dropdown', () => {
    const onChange = vi.fn()
    render(<LanguagePicker value="en-us" onChange={onChange} />)
    fireEvent.click(screen.getByRole('button', { expanded: false }))

    const chineseOption = screen.getAllByRole('option').find((o) => o.textContent?.includes('Chinese'))
    fireEvent.click(chineseOption!)

    expect(onChange).toHaveBeenCalledWith('zh-cn')
    expect(screen.queryByRole('listbox')).not.toBeInTheDocument()
  })

  it('marks currently selected option with aria-selected', () => {
    render(<LanguagePicker value="zh-cn" onChange={vi.fn()} />)
    fireEvent.click(screen.getByRole('button', { expanded: false }))

    const options = screen.getAllByRole('option')
    const selected = options.find((o) => o.getAttribute('aria-selected') === 'true')
    const unselected = options.filter((o) => o.getAttribute('aria-selected') === 'false')

    expect(selected?.textContent).toContain('Chinese')
    expect(unselected).toHaveLength(2)
  })

  it('disables trigger when disabled prop is set', () => {
    render(<LanguagePicker value="en-us" onChange={vi.fn()} disabled />)
    expect(screen.getByRole('button', { expanded: false })).toBeDisabled()
  })

  it('falls back to UNKNOWN display when value is not in the language list', () => {
    render(<LanguagePicker value={'xx-xx' as never} onChange={vi.fn()} />)
    const trigger = screen.getByRole('button', { expanded: false })
    expect(trigger.textContent).toContain('Unknown')
    expect(trigger.textContent).toContain('🏳️')
  })
})
