'use client';

import { FormEvent, useState } from 'react';
import { useRouter } from 'next/navigation';
import { Plus } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { createProject } from '@/lib/api';

export function CreateProjectForm() {
  const router = useRouter();
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function onSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setError(null);
    setIsSubmitting(true);
    const formData = new FormData(event.currentTarget);
    try {
      const project = await createProject({
        name: String(formData.get('name') ?? ''),
        description: String(formData.get('description') ?? '') || undefined
      });
      router.push('/projects/' + project.id);
      router.refresh();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : 'Project could not be created.');
    } finally {
      setIsSubmitting(false);
    }
  }

  return (
    <form className='grid gap-4' onSubmit={onSubmit}>
      <div className='grid gap-2'>
        <Label htmlFor='name'>Project name</Label>
        <Input id='name' name='name' placeholder='Podcast launch clips' required />
      </div>
      <div className='grid gap-2'>
        <Label htmlFor='description'>Description</Label>
        <Input id='description' name='description' placeholder='Optional context' />
      </div>
      {error ? <p className='text-sm text-destructive'>{error}</p> : null}
      <Button disabled={isSubmitting} type='submit'>
        <Plus size={16} aria-hidden />
        {isSubmitting ? 'Creating' : 'Create project'}
      </Button>
    </form>
  );
}
