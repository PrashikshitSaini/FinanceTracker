'use client'

import { useState, useRef } from 'react'
import { Button } from '@/components/ui/button'
import { Camera, Image as ImageIcon, X } from 'lucide-react'
import { supabase } from '@/lib/supabase'
// Using regular img tag for better compatibility with Supabase storage URLs

interface ImageUploadProps {
  currentImageUrl: string | null
  onImageUploaded: (url: string | null) => void
}

export default function ImageUpload({ currentImageUrl, onImageUploaded }: ImageUploadProps) {
  const [uploading, setUploading] = useState(false)
  const fileInputRef = useRef<HTMLInputElement>(null)
  const cameraInputRef = useRef<HTMLInputElement>(null)

  const handleFileSelect = async (file: File | null) => {
    if (!file) return

    setUploading(true)
    try {
      const fileExt = file.name.split('.').pop()
      const fileName = `${Math.random()}.${fileExt}`
      const filePath = `receipts/${fileName}`

      const { error: uploadError } = await supabase.storage
        .from('receipts')
        .upload(filePath, file)

      if (uploadError) throw uploadError

      const { data } = supabase.storage
        .from('receipts')
        .getPublicUrl(filePath)

      onImageUploaded(data.publicUrl)
    } catch (error) {
      // Log error without exposing file paths or user information
      if (process.env.NODE_ENV === 'development') {
        console.error('Error uploading image:', error instanceof Error ? error.message : 'Unknown error')
      }
      alert('Error uploading image. Please try again.')
    } finally {
      setUploading(false)
    }
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
    onImageUploaded(null)
  }

  return (
    <div className="space-y-2">
      <div className="flex gap-2">
        <Button
          type="button"
          variant="outline"
          onClick={handleGalleryClick}
          disabled={uploading}
          className="flex items-center gap-2"
        >
          <ImageIcon className="h-4 w-4" />
          Gallery
        </Button>
        <Button
          type="button"
          variant="outline"
          onClick={handleCameraClick}
          disabled={uploading}
          className="flex items-center gap-2"
        >
          <Camera className="h-4 w-4" />
          Camera
        </Button>
        {currentImageUrl && (
          <Button
            type="button"
            variant="outline"
            onClick={removeImage}
            className="flex items-center gap-2"
          >
            <X className="h-4 w-4" />
            Remove
          </Button>
        )}
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

      {uploading && <p className="text-sm text-muted-foreground">Uploading...</p>}

      {currentImageUrl && (
        <div className="w-full border rounded-md overflow-hidden">
          <img
            src={currentImageUrl}
            alt="Receipt"
            className="w-full h-48 object-contain"
          />
        </div>
      )}
    </div>
  )
}

