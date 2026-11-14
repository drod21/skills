import { createFileRoute } from '@tanstack/react-router'
import { LeadSettings } from '../thread/LeadSettings'

export const Route = createFileRoute('/settings')({
  head: () => ({ meta: [{ title: 'Lead thread | Team board' }] }),
  component: LeadSettings,
})
