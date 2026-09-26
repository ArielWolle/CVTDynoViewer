import { projectToPlot, type ProjectedPoint } from './relationshipHover'
import type { NumericDomain, PlotGeometry } from './plotGeometry'

type GridEntry<T> = { point: T; xPx: number; yPx: number }

export class RelationshipSpatialIndex<T> {
  private readonly cells = new Map<number, GridEntry<T>[]>()
  private readonly columns: number
  private readonly rows: number

  constructor(
    points: readonly T[],
    private readonly xDomain: NumericDomain,
    private readonly yDomain: NumericDomain,
    private readonly plot: PlotGeometry,
    private readonly getX: (point: T) => number,
    private readonly getY: (point: T) => number,
    private readonly cellSize = 24,
  ) {
    this.columns = Math.max(1, Math.ceil(plot.width / cellSize))
    this.rows = Math.max(1, Math.ceil(plot.height / cellSize))
    for (const point of points) {
      const projected = projectToPlot(getX(point), getY(point), xDomain, yDomain, plot)
      if (!projected) continue
      const [column, row] = this.cellFor(projected.xPx, projected.yPx)
      const key = this.key(column, row)
      const entry = { point, xPx: projected.xPx, yPx: projected.yPx }
      const cell = this.cells.get(key)
      if (cell) cell.push(entry)
      else this.cells.set(key, [entry])
    }
  }

  nearest(mouseX: number, mouseY: number): ProjectedPoint<T> | undefined {
    if (
      mouseX < this.plot.left || mouseX > this.plot.left + this.plot.width
      || mouseY < this.plot.top || mouseY > this.plot.top + this.plot.height
    ) return undefined

    const [originColumn, originRow] = this.cellFor(mouseX, mouseY)
    let best: ProjectedPoint<T> | undefined
    let bestDistanceSquared = Infinity
    const maxRadius = Math.max(this.columns, this.rows)

    for (let radius = 0; radius < maxRadius; radius += 1) {
      const minColumn = Math.max(0, originColumn - radius)
      const maxColumn = Math.min(this.columns - 1, originColumn + radius)
      const minRow = Math.max(0, originRow - radius)
      const maxRow = Math.min(this.rows - 1, originRow + radius)

      for (let row = minRow; row <= maxRow; row += 1) {
        for (let column = minColumn; column <= maxColumn; column += 1) {
          if (radius > 0 && column > minColumn && column < maxColumn && row > minRow && row < maxRow) continue
          for (const entry of this.cells.get(this.key(column, row)) ?? []) {
            const dx = entry.xPx - mouseX
            const dy = entry.yPx - mouseY
            const distanceSquared = dx * dx + dy * dy
            if (distanceSquared < bestDistanceSquared) {
              bestDistanceSquared = distanceSquared
              best = { ...entry, distanceSquared }
            }
          }
        }
      }

      const outsideDistances: number[] = []
      if (minColumn > 0) outsideDistances.push(mouseX - (this.plot.left + minColumn * this.cellSize))
      if (maxColumn < this.columns - 1) outsideDistances.push(this.plot.left + Math.min(this.plot.width, (maxColumn + 1) * this.cellSize) - mouseX)
      if (minRow > 0) outsideDistances.push(mouseY - (this.plot.top + minRow * this.cellSize))
      if (maxRow < this.rows - 1) outsideDistances.push(this.plot.top + Math.min(this.plot.height, (maxRow + 1) * this.cellSize) - mouseY)

      if (!outsideDistances.length) return best
      const minOutsideDistance = Math.max(0, Math.min(...outsideDistances))
      if (best && bestDistanceSquared <= minOutsideDistance * minOutsideDistance) return best
    }

    return best
  }

  private cellFor(xPx: number, yPx: number): [number, number] {
    const column = Math.min(this.columns - 1, Math.max(0, Math.floor((xPx - this.plot.left) / this.cellSize)))
    const row = Math.min(this.rows - 1, Math.max(0, Math.floor((yPx - this.plot.top) / this.cellSize)))
    return [column, row]
  }

  private key(column: number, row: number) {
    return row * this.columns + column
  }
}
