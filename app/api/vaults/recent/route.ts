import { NextResponse } from 'next/server';
import { loadVaults } from '@/lib/vaults';

export const dynamic = 'force-dynamic';
export const revalidate = 0;

export async function GET(request: Request) {
  try {
    const { searchParams } = new URL(request.url);
    const page = parseInt(searchParams.get('page') || '1');
    const limit = parseInt(searchParams.get('limit') || '40');

    const vaults = await loadVaults();
    const totalVaults = vaults.length;

    // Transform to match Broadcast component interface
    const recentVaults = vaults.map(vault => ({
      name: vault.name,
      symbol: vault.symbol,
      priceChange: vault.priceChange24h,
    }));

    // Only paginate if totalVaults > 40
    if (totalVaults > 40) {
      const skip = (page - 1) * limit;
      const paginatedVaults = recentVaults.slice(skip, skip + limit);

      return NextResponse.json({
        data: paginatedVaults,
        pagination: {
          total: totalVaults,
          page,
          limit,
          totalPages: Math.ceil(totalVaults / limit),
          hasMore: skip + limit < totalVaults
        }
      });
    }

    // Return all vaults without pagination if <= 40
    return NextResponse.json(recentVaults);
  } catch (error) {
    console.error('Failed to load vaults:', error);
    return NextResponse.json(
      { error: 'Failed to load vaults' },
      { status: 500 }
    );
  }
}
