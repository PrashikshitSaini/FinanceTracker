'use client'

import { useState, useEffect, useCallback } from 'react'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogFooter,
} from '@/components/ui/dialog'
import { Plus, Trash2, Copy, Check, Key, AlertTriangle } from 'lucide-react'

interface ApiKey {
  id: string
  name: string
  key_prefix: string
  created_at: string
  last_used_at: string | null
}

export default function ApiKeys() {
  const [keys, setKeys] = useState<ApiKey[]>([])
  const [loading, setLoading] = useState(true)
  const [isGenerating, setIsGenerating] = useState(false)
  const [keyName, setKeyName] = useState('')
  const [showGenerateDialog, setShowGenerateDialog] = useState(false)
  const [newKey, setNewKey] = useState<string | null>(null)
  const [copied, setCopied] = useState(false)
  const [deletingId, setDeletingId] = useState<string | null>(null)
  const [confirmDeleteId, setConfirmDeleteId] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)

  const fetchKeys = useCallback(async () => {
    try {
      const res = await fetch('/api/api-keys')
      if (res.ok) setKeys(await res.json())
    } catch {
      // silently fail
    } finally {
      setLoading(false)
    }
  }, [])

  useEffect(() => {
    fetchKeys()
  }, [fetchKeys])

  const handleGenerate = async () => {
    if (!keyName.trim()) return
    setIsGenerating(true)
    setError(null)
    try {
      const res = await fetch('/api/api-keys', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name: keyName.trim() }),
      })
      const data = await res.json()
      if (!res.ok) {
        setError(data.error || 'Failed to create key')
        return
      }
      setNewKey(data.key)
      setKeys(prev => [
        { id: data.id, name: data.name, key_prefix: data.key_prefix, created_at: data.created_at, last_used_at: null },
        ...prev,
      ])
      setShowGenerateDialog(false)
      setKeyName('')
    } catch {
      setError('Failed to create key. Please try again.')
    } finally {
      setIsGenerating(false)
    }
  }

  const handleDelete = async (id: string) => {
    setDeletingId(id)
    try {
      const res = await fetch(`/api/api-keys/${id}`, { method: 'DELETE' })
      if (res.ok) {
        setKeys(prev => prev.filter(k => k.id !== id))
      }
    } finally {
      setDeletingId(null)
      setConfirmDeleteId(null)
    }
  }

  const handleCopy = async () => {
    if (!newKey) return
    try {
      await navigator.clipboard.writeText(newKey)
      setCopied(true)
      setTimeout(() => setCopied(false), 2000)
    } catch {
      // clipboard may be unavailable
    }
  }

  const formatDate = (iso: string | null) => {
    if (!iso) return 'never'
    return new Date(iso).toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' })
  }

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between">
        <h3 className="text-lg font-semibold flex items-center gap-2">
          <Key className="h-5 w-5" />
          API Keys
        </h3>
        <Button
          size="sm"
          onClick={() => { setShowGenerateDialog(true); setError(null) }}
        >
          <Plus className="h-4 w-4 mr-1" />
          Generate
        </Button>
      </div>

      <p className="text-sm text-muted-foreground">
        Use API keys to authenticate the quick-add endpoint from external automations (e.g. Android shortcuts) without needing a session token.
      </p>

      {loading ? (
        <div className="text-sm text-muted-foreground py-4 text-center">Loading...</div>
      ) : keys.length === 0 ? (
        <div className="text-sm text-muted-foreground py-6 text-center border rounded-lg">
          No API keys yet. Generate one to get started.
        </div>
      ) : (
        <div className="divide-y border rounded-lg">
          {keys.map(key => (
            <div key={key.id} className="px-4 py-3">
              <div className="flex items-center justify-between gap-2">
                <div className="min-w-0">
                  <div className="flex items-center gap-2 flex-wrap">
                    <span className="font-medium text-sm truncate">{key.name}</span>
                    <code className="text-xs text-muted-foreground bg-muted px-1.5 py-0.5 rounded font-mono">
                      {key.key_prefix}…
                    </code>
                  </div>
                  <div className="text-xs text-muted-foreground mt-0.5">
                    Created {formatDate(key.created_at)} · Last used: {formatDate(key.last_used_at)}
                  </div>
                </div>
                <div className="flex items-center gap-2 flex-shrink-0">
                  {confirmDeleteId === key.id ? (
                    <>
                      <Button
                        variant="outline"
                        size="sm"
                        className="text-xs h-7"
                        onClick={() => setConfirmDeleteId(null)}
                      >
                        Cancel
                      </Button>
                      <Button
                        variant="destructive"
                        size="sm"
                        className="text-xs h-7"
                        disabled={deletingId === key.id}
                        onClick={() => handleDelete(key.id)}
                      >
                        {deletingId === key.id ? 'Deleting…' : 'Delete'}
                      </Button>
                    </>
                  ) : (
                    <Button
                      variant="ghost"
                      size="sm"
                      className="h-7 w-7 p-0 text-muted-foreground hover:text-destructive"
                      onClick={() => setConfirmDeleteId(key.id)}
                    >
                      <Trash2 className="h-4 w-4" />
                    </Button>
                  )}
                </div>
              </div>
            </div>
          ))}
        </div>
      )}

      {/* Generate dialog */}
      <Dialog open={showGenerateDialog} onOpenChange={setShowGenerateDialog}>
        <DialogContent className="sm:max-w-md">
          <DialogHeader>
            <DialogTitle>Generate API Key</DialogTitle>
          </DialogHeader>
          <div className="space-y-3 py-2">
            <div className="space-y-1.5">
              <Label htmlFor="key-name">Key name</Label>
              <Input
                id="key-name"
                placeholder="e.g. Android Phone"
                value={keyName}
                onChange={e => setKeyName(e.target.value)}
                onKeyDown={e => { if (e.key === 'Enter') handleGenerate() }}
                autoFocus
              />
            </div>
            {error && <p className="text-sm text-destructive">{error}</p>}
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => setShowGenerateDialog(false)}>
              Cancel
            </Button>
            <Button onClick={handleGenerate} disabled={isGenerating || !keyName.trim()}>
              {isGenerating ? 'Generating…' : 'Generate'}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* One-time reveal dialog */}
      <Dialog open={!!newKey} onOpenChange={() => { setNewKey(null); setCopied(false) }}>
        <DialogContent className="sm:max-w-md">
          <DialogHeader>
            <DialogTitle className="flex items-center gap-2">
              <AlertTriangle className="h-5 w-5 text-amber-500" />
              Copy your API key now
            </DialogTitle>
          </DialogHeader>
          <div className="space-y-3 py-2">
            <p className="text-sm text-muted-foreground">
              This key will <strong>not</strong> be shown again. Copy it and store it somewhere safe.
            </p>
            <div className="flex items-center gap-2">
              <code className="flex-1 text-xs bg-muted px-3 py-2 rounded font-mono break-all select-all">
                {newKey}
              </code>
              <Button
                variant="outline"
                size="sm"
                className="flex-shrink-0"
                onClick={handleCopy}
              >
                {copied ? <Check className="h-4 w-4 text-green-600" /> : <Copy className="h-4 w-4" />}
              </Button>
            </div>
            <p className="text-xs text-muted-foreground">
              Use it in the <code className="bg-muted px-1 rounded">X-API-Key</code> header when calling <code className="bg-muted px-1 rounded">/api/quick-add</code>.
            </p>
          </div>
          <DialogFooter>
            <Button onClick={() => { setNewKey(null); setCopied(false) }}>
              Done
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  )
}
