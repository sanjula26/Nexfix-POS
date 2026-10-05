-- The atomic sale function now owns Kit/BOM stock consumption.
-- Remove the older sale_items trigger so Kit component stock is not decremented twice
-- and the Kit catalog row is not artificially incremented after a sale.

drop trigger if exists sale_items_consume_kit_bom on public.sale_items;
