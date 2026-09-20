import { NextResponse } from 'next/server'
import { createClient } from '@/lib/supabase/server'
import { requireRole, toErrorResponse } from '@/lib/auth/account'
import { supabaseAdmin } from '@/lib/automations/admin-client'
import { insertSteps, replaceSteps, type BuilderStepInput } from '@/lib/automations/steps-tree'
import { validateStepsForActivation, validateTriggerForActivation } from '@/lib/automations/validate'
import config from '@/lib/automations/digital-marketing-services.json'

type Service = {
  id: string
  name: string
  description: string
  confirmation: string
}

export async function POST() {
  try {
    await requireRole('agent')
  } catch (err) {
    return toErrorResponse(err)
  }

  const supabase = await createClient()
  const {
    data: { user },
  } = await supabase.auth.getUser()

  if (!user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })

  const admin = supabaseAdmin()
  const { data: profile, error: profileError } = await supabase
    .from('profiles')
    .select('account_id')
    .eq('user_id', user.id)
    .single()

  if (profileError || !profile?.account_id) {
    return NextResponse.json(
      { error: 'Your profile is not linked to an account.' },
      { status: 403 },
    )
  }

  const accountId = profile.account_id as string
  const services = config.services as Service[]

  // Reuse the account's existing Test Automation tag, or create it once.
  let { data: tag } = await admin
    .from('tags')
    .select('id')
    .eq('account_id', accountId)
    .eq('name', config.common_tag)
    .limit(1)
    .maybeSingle()

  if (!tag) {
    const { data: createdTag, error } = await admin
      .from('tags')
      .insert({
        user_id: user.id,
        account_id: accountId,
        name: config.common_tag,
        color: '#3b82f6',
      })
      .select('id')
      .single()

    if (error || !createdTag) {
      return NextResponse.json(
        { error: error?.message ?? 'Could not create Test Automation tag.' },
        { status: 500 },
      )
    }
    tag = createdTag
  }

  // Reuse/create the contact custom field used to remember the selected service.
  let { data: field } = await admin
    .from('custom_fields')
    .select('id')
    .eq('account_id', accountId)
    .eq('field_name', config.custom_field.name)
    .limit(1)
    .maybeSingle()

  if (!field) {
    const { data: createdField, error } = await admin
      .from('custom_fields')
      .insert({
        user_id: user.id,
        account_id: accountId,
        field_name: config.custom_field.name,
        field_type: config.custom_field.type,
        field_options: null,
      })
      .select('id')
      .single()

    if (error || !createdField) {
      return NextResponse.json(
        { error: error?.message ?? 'Could not create Interested Service field.' },
        { status: 500 },
      )
    }
    field = createdField
  }

  const menuPayload = {
    kind: 'list' as const,
    header: config.menu.header,
    body: config.menu.body,
    footer: config.menu.footer,
    button_label: config.menu.button_label,
    sections: [
      {
        title: 'Digital Marketing',
        rows: services.map((service) => ({
          id: service.id,
          title: service.name,
          description: service.description,
        })),
      },
    ],
  }

  const menuSteps: BuilderStepInput[] = [
    {
      step_type: 'send_list',
      step_config: menuPayload,
    },
  ]

  const created: string[] = []
  const updated: string[] = []

  async function saveAutomation(
    name: string,
    description: string,
    triggerConfig: Record<string, unknown>,
    steps: BuilderStepInput[],
  ) {
    const triggerType = name === 'Digital Marketing Service Menu'
      ? 'keyword_match'
      : 'interactive_reply'

    const issues = [
      ...validateTriggerForActivation(triggerType, triggerConfig),
      ...validateStepsForActivation(steps),
    ]
    if (issues.length) {
      throw new Error(JSON.stringify(issues))
    }

    const { data: existing, error: lookupError } = await admin
      .from('automations')
      .select('id')
      .eq('account_id', accountId)
      .eq('name', name)
      .limit(1)
      .maybeSingle()

    if (lookupError) throw new Error(lookupError.message)

    if (existing?.id) {
      const { error: updateError } = await admin
        .from('automations')
        .update({
          user_id: user.id,
          description,
          trigger_type: triggerType,
          trigger_config: triggerConfig,
          is_active: true,
        })
        .eq('id', existing.id)
        .eq('account_id', accountId)

      if (updateError) throw new Error(updateError.message)

      const stepError = await replaceSteps(existing.id, steps)
      if (stepError) throw new Error(stepError)

      updated.push(name)
      return
    }

    const { data: automation, error: insertError } = await admin
      .from('automations')
      .insert({
        user_id: user.id,
        account_id: accountId,
        name,
        description,
        trigger_type: triggerType,
        trigger_config: triggerConfig,
        is_active: true,
      })
      .select('id')
      .single()

    if (insertError || !automation) {
      throw new Error(insertError?.message ?? 'Could not create automation.')
    }

    const stepError = await insertSteps(automation.id, steps)
    if (stepError) throw new Error(stepError)

    created.push(name)
  }

  try {
    await saveAutomation(
      'Digital Marketing Service Menu',
      'Shows the 8 Digital Marketing services when a customer says Hi, Hello, or Start.',
      {
        keywords: config.menu.keywords,
        match_type: 'exact',
        case_sensitive: false,
      },
      menuSteps,
    )

    for (const service of services) {
      await saveAutomation(
        `Digital Marketing — ${service.name}`,
        `Handles the ${service.name} selection from the Digital Marketing menu.`,
        { reply_ids: [service.id] },
        [
          {
            step_type: 'update_contact_field',
            step_config: {
              field: `custom:${field.id}`,
              value: service.name,
            },
          },
          {
            step_type: 'add_tag',
            step_config: { tag_id: tag.id },
          },
          {
            step_type: 'send_message',
            step_config: { text: service.confirmation },
          },
        ],
      )
    }
  } catch (error) {
    return NextResponse.json(
      {
        error: error instanceof Error ? error.message : String(error),
        created,
        updated,
      },
      { status: 500 },
    )
  }

  return NextResponse.json({
    ok: true,
    message: 'Digital Marketing automation installed.',
    created,
    updated,
    services: services.map((s) => s.name),
    tag: config.common_tag,
    custom_field: config.custom_field.name,
  })
}
