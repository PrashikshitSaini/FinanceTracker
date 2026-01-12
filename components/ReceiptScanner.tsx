'use client'

import { useState, useRef } from 'react'
import { Button } from '@/components/ui/button'
import { Dialog, DialogContent, DialogHeader, DialogTitle } from '@/components/ui/dialog'
import { Camera, Image as ImageIcon, X, Loader2, CheckCircle2, AlertCircle } from 'lucide-react'
import { supabase } from '@/lib/supabase'
import { useCurrency } from '@/contexts/CurrencyContext'

interface ReceiptScannerProps {
  open: boolean
  onOpenChange: (open: boolean) => void
  onTransactionAdded?: () => void
}

export default function ReceiptScanner({ open, onOpenChange, onTransactionAdded }: ReceiptScannerProps) {
  const [uploading, setUploading] = useState(false)
  const [processing, setProcessing] = useState(false)
  const [imagePreview, setImagePreview] = useState<string | null>(null)
  const [imageFile, setImageFile] = useState<File | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [success, setSuccess] = useState(false)
  const fileInputRef = useRef<HTMLInputElement>(null)
  const cameraInputRef = useRef<HTMLInputElement>(null)

  const handleFileSelect = async (file: File | null) => {
    if (!file) return

    setError(null)
    setSuccess(false)
    setImageFile(file)

    // Create preview
    const reader = new FileReader()
    reader.onloadend = () => {
      setImagePreview(reader.result as string)
    }
    reader.readAsDataURL(file)
  }

  const handleGalleryClick = () => {
    fileInputRef.current?.click()
  }

  const handleCameraClick = () => {
    cameraInputRef.current?.click()
  }

  const handleFileChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0]
    if (file) handleFileSelect(file)
  }

  const removeImage = () => {
    setImageFile(null)
    setImagePreview(null)
    setError(null)
    setSuccess(false)
    if (fileInputRef.current) fileInputRef.current.value = ''
    if (cameraInputRef.current) cameraInputRef.current.value = ''
  }

  const compressImage = (file: File, maxWidth: number = 1920, quality: number = 0.8): Promise<File> => {
    return new Promise((resolve, reject) => {
      const reader = new FileReader()
      reader.onload = (e) => {
        const img = new Image()
        img.onload = () => {
          const canvas = document.createElement('canvas')
          let width = img.width
          let height = img.height

          if (width > maxWidth) {
            height = (height * maxWidth) / width
            width = maxWidth
          }

          canvas.width = width
          canvas.height = height

          const ctx = canvas.getContext('2d')
          if (!ctx) {
            reject(new Error('Could not get canvas context'))
            return
          }

          ctx.drawImage(img, 0, 0, width, height)

          canvas.toBlob(
            (blob) => {
              if (!blob) {
                reject(new Error('Failed to compress image'))
                return
              }
              const compressedFile = new File([blob], file.name, {
                type: 'image/jpeg',
                lastModified: Date.now(),
              })
              resolve(compressedFile)
            },
            'image/jpeg',
            quality
          )
        }
        img.onerror = reject
        img.src = e.target?.result as string
      }
      reader.onerror = reject
      reader.readAsDataURL(file)
    })
  }

  const convertToBase64 = (file: File): Promise<string> => {
    return new Promise((resolve, reject) => {
      const reader = new FileReader()
      reader.onloadend = () => {
        const result = reader.result as string
        resolve(result)
      }
      reader.onerror = reject
      reader.readAsDataURL(file)
    })
  }

  const processReceipt = async () => {
    if (!imageFile) {
      setError('Please select an image first')
      return
    }

    setProcessing(true)
    setError(null)
    setSuccess(false)

    try {
      // Get authenticated user and session - need access token for API route
      const { data: { session }, error: sessionError } = await supabase.auth.getSession()
      
      if (sessionError || !session?.user || !session.access_token) {
        setError('You must be logged in to scan receipts')
        setProcessing(false)
        return
      }

      const user = session.user // Store user for later use

      // Compress image before converting to base64 to avoid Vercel body size limits
      const compressedImage = await compressImage(imageFile, 1920, 0.8)
      const imageBase64 = await convertToBase64(compressedImage)

      // Call API to process receipt - pass access token in Authorization header
      const receiptResponse = await fetch('/api/receipt', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${session.access_token}`,
        },
        credentials: 'include', // Include cookies as backup
        body: JSON.stringify({ imageBase64 }),
      })

      const receiptResult = await receiptResponse.json()

      if (!receiptResponse.ok) {
        throw new Error(receiptResult.error || 'Failed to process receipt')
      }

      if (!receiptResult.success || !receiptResult.data) {
        throw new Error('Invalid response from server')
      }

      const extractedData = receiptResult.data

      // Clear the image from memory immediately after processing
      removeImage()

      // Use today's date to ensure transaction appears in current month view immediately
      // This ensures the receipt shows up right away regardless of what date was on the receipt
      const today = new Date().toISOString().split('T')[0]
      const transactionDate = today // Always use today's date so it shows in current month view

      // Create transaction with extracted data (no image storage - deleted immediately after processing)
      const transactionData = {
        amount: extractedData.amount || 0,
        category: extractedData.category || '',
        payment_source: extractedData.payment_source || '',
        notes: extractedData.notes || null,
        image_url: null, // Don't store receipt images - processed and deleted immediately
        date: transactionDate,
        type: 'expense' as const,
        user_id: user.id,
      }

      const { error: insertError, data: insertedData } = await supabase
        .from('transactions')
        .insert([transactionData])
        .select()

      if (insertError) {
        console.error('Insert error:', insertError)
        throw new Error(`Failed to save transaction: ${insertError.message}`)
      }

      if (!insertedData || insertedData.length === 0) {
        throw new Error('Transaction was not created - no data returned')
      }

      // Log success without exposing transaction PII (amount, notes, etc.)
      if (process.env.NODE_ENV === 'development') {
        console.log('Transaction created successfully:', insertedData.length, 'record(s)')
      }

      setSuccess(true)
      
      // Call refresh callback to update the dashboard immediately
      if (onTransactionAdded) {
        onTransactionAdded()
      }
      
      // Reset form and reload page after showing success message (same approach as TransactionForm)
      setTimeout(() => {
        resetAndClose()
        // Force a page reload to ensure all views update - same as TransactionForm does
        window.location.reload()
      }, 1500)
    } catch (err: any) {
      // Log error without exposing PII - only log error message
      if (process.env.NODE_ENV === 'development') {
        console.error('Receipt processing error:', err?.message || 'Unknown error')
      }
      setError(err.message || 'Failed to process receipt. Please try again.')
    } finally {
      setProcessing(false)
    }
  }

  const resetAndClose = () => {
    removeImage()
    setProcessing(false)
    setError(null)
    setSuccess(false)
    onOpenChange(false)
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-md">
        <DialogHeader>
          <DialogTitle>Scan Receipt</DialogTitle>
        </DialogHeader>

        <div className="space-y-4">
          {!imagePreview ? (
            <div className="space-y-2">
              <div className="flex gap-2">
                <Button
                  type="button"
                  variant="outline"
                  onClick={handleGalleryClick}
                  disabled={uploading || processing}
                  className="flex-1 flex items-center gap-2"
                >
                  <ImageIcon className="h-4 w-4" />
                  Gallery
                </Button>
                <Button
                  type="button"
                  variant="outline"
                  onClick={handleCameraClick}
                  disabled={uploading || processing}
                  className="flex-1 flex items-center gap-2"
                >
                  <Camera className="h-4 w-4" />
                  Camera
                </Button>
              </div>

              <input
                ref={fileInputRef}
                type="file"
                accept="image/*"
                onChange={handleFileChange}
                className="hidden"
              />
              <input
                ref={cameraInputRef}
                type="file"
                accept="image/*"
                capture="environment"
                onChange={handleFileChange}
                className="hidden"
              />
            </div>
          ) : (
            <div className="space-y-4">
              <div className="relative w-full border rounded-md overflow-hidden">
                <img
                  src={imagePreview}
                  alt="Receipt preview"
                  className="w-full h-64 object-contain bg-muted"
                />
                <Button
                  type="button"
                  variant="ghost"
                  size="icon"
                  onClick={removeImage}
                  disabled={processing}
                  className="absolute top-2 right-2"
                >
                  <X className="h-4 w-4" />
                </Button>
              </div>

              {error && (
                <div className="flex items-start gap-2 p-3 bg-red-50 dark:bg-red-950/20 border border-red-200 dark:border-red-800 rounded-md">
                  <AlertCircle className="h-5 w-5 text-red-600 dark:text-red-400 flex-shrink-0 mt-0.5" />
                  <p className="text-sm text-red-800 dark:text-red-200">{error}</p>
                </div>
              )}

              {success && (
                <div className="flex items-start gap-2 p-3 bg-green-50 dark:bg-green-950/20 border border-green-200 dark:border-green-800 rounded-md">
                  <CheckCircle2 className="h-5 w-5 text-green-600 dark:text-green-400 flex-shrink-0 mt-0.5" />
                  <p className="text-sm text-green-800 dark:text-green-200">
                    Receipt processed successfully! Transaction added.
                  </p>
                </div>
              )}

              <div className="flex gap-2">
                <Button
                  type="button"
                  variant="outline"
                  onClick={removeImage}
                  disabled={processing}
                  className="flex-1"
                >
                  Change Image
                </Button>
                <Button
                  type="button"
                  onClick={processReceipt}
                  disabled={processing || success}
                  className="flex-1"
                >
                  {processing ? (
                    <>
                      <Loader2 className="h-4 w-4 mr-2 animate-spin" />
                      Processing...
                    </>
                  ) : success ? (
                    <>
                      <CheckCircle2 className="h-4 w-4 mr-2" />
                      Success!
                    </>
                  ) : (
                    'Process Receipt'
                  )}
                </Button>
              </div>
            </div>
          )}

          <p className="text-xs text-muted-foreground text-center">
            AI will automatically extract transaction details from your receipt
          </p>
        </div>
      </DialogContent>
    </Dialog>
  )
}
