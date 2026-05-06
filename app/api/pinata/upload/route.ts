import { NextRequest, NextResponse } from 'next/server';

const PINATA_JWT = process.env.PINATA_JWT;
const PINATA_GATEWAY = 'cyan-defeated-lemming-99.mypinata.cloud';

export async function POST(request: NextRequest) {
  // Check if Pinata is configured
  if (!PINATA_JWT) {
    return NextResponse.json(
      { error: 'Pinata not configured' },
      { status: 503 }
    );
  }

  try {
    const formData = await request.formData();
    const file = formData.get('file') as File | null;
    const metadataStr = formData.get('metadata') as string | null;

    let uploadData: FormData;
    let fileName: string;

    if (file) {
      // File upload
      uploadData = new FormData();
      uploadData.append('file', file);
      fileName = file.name;
    } else if (metadataStr) {
      // Metadata JSON upload
      const blob = new Blob([metadataStr], { type: 'application/json' });
      uploadData = new FormData();
      uploadData.append('file', blob, 'metadata.json');
      fileName = 'metadata.json';
    } else {
      return NextResponse.json(
        { error: 'No file or metadata provided' },
        { status: 400 }
      );
    }

    // Upload to Pinata
    const response = await fetch('https://api.pinata.cloud/pinning/pinFileToIPFS', {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${PINATA_JWT}`,
      },
      body: uploadData,
    });

    if (!response.ok) {
      const errorText = await response.text();
      console.error('Pinata upload error:', errorText);
      return NextResponse.json(
        { error: 'Pinata upload failed' },
        { status: 500 }
      );
    }

    const result = await response.json();
    const ipfsHash = result.IpfsHash;
    const ipfsUrl = `ipfs://${ipfsHash}`;
    const gatewayUrl = `https://${PINATA_GATEWAY}/ipfs/${ipfsHash}`;

    return NextResponse.json({
      ipfsUrl,
      gatewayUrl,
      hash: ipfsHash,
    });
  } catch (error) {
    console.error('Upload error:', error);
    return NextResponse.json(
      { error: 'Upload failed' },
      { status: 500 }
    );
  }
}
