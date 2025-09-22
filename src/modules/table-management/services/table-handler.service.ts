import { Injectable, Logger } from '@nestjs/common';
// import { isEqual } from 'lodash'; // Unused import removed
import { DataSourceService } from '../../../core/database/data-source/data-source.service';
import { MetadataSyncService } from '../../schema-management/services/metadata-sync.service';
import { LoggingService } from '../../../core/exceptions/services/logging.service';
import {
  DatabaseException,
  DuplicateResourceException,
  ResourceNotFoundException,
  ValidationException,
} from '../../../core/exceptions/custom-exceptions';
import { validateUniquePropertyNames } from '../utils/duplicate-field-check';
import { getDeletedIds } from '../utils/get-deleted-ids';
import { CreateTableDto } from '../dto/create-table.dto';

@Injectable()
export class TableHandlerService {
  private logger = new Logger(TableHandlerService.name);

  constructor(
    private dataSourceService: DataSourceService,
    private metadataSyncService: MetadataSyncService,
    private loggingService: LoggingService,
  ) {}

  private validateRelations(relations: any[]) {
    for (const relation of relations || []) {
      if (relation.type === 'one-to-many' && !relation.inversePropertyName) {
        throw new ValidationException(
          `One-to-many relation '${relation.propertyName}' must have inversePropertyName`,
          {
            relationName: relation.propertyName,
            relationType: relation.type,
            missingField: 'inversePropertyName'
          }
        );
      }
    }
  }

  async createTable(body: any) {
    // Validate relations before proceeding
    this.validateRelations(body.relations);
    
    const dataSource = this.dataSourceService.getDataSource();
    const tableEntity =
      this.dataSourceService.entityClassMap.get('table_definition');
    const tableRepo = dataSource.getRepository(tableEntity);
    const queryRunner = dataSource.createQueryRunner();
    await queryRunner.connect();

    try {
      const hasTable = await queryRunner.hasTable(body.name);
      const existing = await dataSource
        .getRepository(tableEntity)
        .findOne({ where: { name: body.name } });

      if (hasTable && existing) {
        throw new Error(`Table ${body.name} already exists!`);
      }

      const idCol = body.columns.find(
        (col: any) => col.name === 'id' && col.isPrimary,
      );
      if (!idCol) {
        throw new Error(
          `Table must contain a column named "id" with isPrimary = true.`,
        );
      }

      const validTypes = ['int', 'uuid'];
      if (!validTypes.includes(idCol.type)) {
        throw new Error(`The primary column "id" must be of type int or uuid.`);
      }

      const primaryCount = body.columns.filter(
        (col: any) => col.isPrimary,
      ).length;
      if (primaryCount !== 1) {
        throw new Error(`Only one column is allowed to have isPrimary = true.`);
      }

      validateUniquePropertyNames(body.columns || [], body.relations || []);

      const newTable = { ...body };

      if (body.columns) {
        newTable.columns = body.columns.map((col) => {
          const { table, ...colWithoutTable } = col;
          return colWithoutTable;
        });
      }

      if (body.relations) {
        newTable.relations = body.relations.map((rel) => {
          const { sourceTable, ...relWithoutSourceTable } = rel;
          return relWithoutSourceTable;
        });
      }

      const result: any = await tableRepo.save(newTable);

      await this.afterEffect({ entityName: result.name, type: 'create' });

      // Check if route already exists before creating
      const routeDefRepo =
        this.dataSourceService.getRepository('route_definition');
      const existingRoute = await routeDefRepo.findOne({
        where: { path: `/${result.name}` }
      });

      if (!existingRoute) {
        await routeDefRepo.save({
          path: `/${result.name}`,
          mainTable: result.id,
          isEnabled: true,
        });
        this.logger.log(`✅ Route /${result.name} created for table ${result.name}`);
      } else {
        this.logger.warn(`Route /${result.name} already exists, skipping route creation`);
      }

      return result;
    } catch (error) {
      this.loggingService.error('Table creation failed', {
        context: 'createTable',
        error: error.message,
        stack: error.stack,
        tableName: body?.name,
        columnCount: body?.columns?.length,
        relationCount: body?.relations?.length,
      });

      if (error.message?.includes('already exists')) {
        throw new DuplicateResourceException(
          'Table',
          'name',
          body?.name || 'unknown',
        );
      }

      throw new DatabaseException(`Failed to create table: ${error.message}`, {
        tableName: body?.name,
        operation: 'create',
      });
    } finally {
      await queryRunner.release();
    }
  }

  async updateTable(id: number, body: CreateTableDto) {
    // Validate relations before proceeding
    this.validateRelations(body.relations);
    
    const dataSource = this.dataSourceService.getDataSource();

    const tableEntity =
      this.dataSourceService.entityClassMap.get('table_definition');
    const columnEntity =
      this.dataSourceService.entityClassMap.get('column_definition');
    const relationEntity = this.dataSourceService.entityClassMap.get(
      'relation_definition',
    );

    const queryRunner = dataSource.createQueryRunner();
    await queryRunner.connect();

    try {
      const tableRepo = dataSource.getRepository(tableEntity);
      const columnRepo = dataSource.getRepository(columnEntity);
      const relationRepo = dataSource.getRepository(relationEntity);

      const exists: any = await tableRepo.findOne({
        where: { id },
        relations: ['columns', 'relations'],
      });

      if (!exists) {
        throw new Error(`Table ${body.name} does not exist.`);
      }

      if (!body.columns?.some((col: any) => col.isPrimary)) {
        throw new Error(
          `Table must contain an id column with isPrimary = true!`,
        );
      }

      validateUniquePropertyNames(body.columns || [], body.relations || []);

      // Handle deletion of columns and relations (if not system, deletion is allowed)
      const deletedColumnIds = getDeletedIds(exists.columns, body.columns);
      const deletedRelationIds = getDeletedIds(
        exists.relations,
        body.relations,
      );
      if (deletedColumnIds.length) await columnRepo.delete(deletedColumnIds);
      if (deletedRelationIds.length)
        await relationRepo.delete(deletedRelationIds);
      this.logger.debug('Updating table with body:', body);

      // Update existing table properties
      Object.assign(exists, body);

      // Ensure new relations are properly linked to the table
      if (body.relations) {
        exists.relations = body.relations.map((rel) => ({
          ...rel,
          sourceTable: exists.id,
        }));
      }

      // Ensure new columns are properly linked to the table
      if (body.columns) {
        exists.columns = body.columns.map((col) => ({
          ...col,
          table: exists.id,
        }));
      }

      const result = await tableRepo.save(exists);

      await this.afterEffect({ entityName: result.name, type: 'update' });
      return result;
    } catch (error) {
      this.loggingService.error('Table update failed', {
        context: 'updateTable',
        error: error.message,
        stack: error.stack,
        tableId: id,
        tableName: body?.name,
        columnCount: body?.columns?.length,
        relationCount: body?.relations?.length,
      });

      if (error.message?.includes('does not exist')) {
        throw new ResourceNotFoundException('Table', id.toString());
      }

      throw new DatabaseException(`Failed to update table: ${error.message}`, {
        tableId: id,
        tableName: body?.name,
        operation: 'update',
      });
    } finally {
      await queryRunner.release();
    }
  }

  async delete(id: number) {
    const tableDefRepo: any =
      this.dataSourceService.getRepository('table_definition');
    const dataSource = this.dataSourceService.getDataSource();
    const queryRunner = dataSource.createQueryRunner();

    let exists: any = null;

    try {
      exists = await tableDefRepo.findOne({
        where: { id },
        relations: ['columns', 'relations']
      });

      if (!exists) {
        throw new Error(`Table with id ${id} does not exist.`);
      }

      await queryRunner.connect();

      const tableName = exists.name;
      this.logger.log(`🗑️ Processing deletion for table: ${tableName}`);

      // 1. Delete routes that point to this table
      const routeDefRepo = this.dataSourceService.getRepository('route_definition');
      const routeDeleted = await routeDefRepo.delete({ mainTable: { id } });
      if (routeDeleted.affected > 0) {
        this.logger.log(`✅ Deleted ${routeDeleted.affected} route(s) pointing to table ${tableName}`);
      }

      // 2. Delete all relations that reference this table as targetTable
      const relationDefRepo = this.dataSourceService.getRepository('relation_definition');
      const targetRelations = await relationDefRepo.delete({ targetTable: { id } });
      if (targetRelations.affected > 0) {
        this.logger.log(`✅ Deleted ${targetRelations.affected} relations referencing table ${tableName} as target`);
      }

      // 3. Drop all foreign keys referencing this table (from other tables)
      const referencingFKs = await queryRunner.query(`
        SELECT DISTINCT TABLE_NAME, CONSTRAINT_NAME
        FROM information_schema.KEY_COLUMN_USAGE
        WHERE CONSTRAINT_SCHEMA = DATABASE()
          AND REFERENCED_TABLE_NAME = '${tableName}'
          AND CONSTRAINT_NAME LIKE 'FK_%'
      `);

      for (const fk of referencingFKs) {
        try {
          await queryRunner.query(
            `ALTER TABLE \`${fk.TABLE_NAME}\` DROP FOREIGN KEY \`${fk.CONSTRAINT_NAME}\``,
          );
          this.logger.debug(
            `Dropped referencing FK: ${fk.CONSTRAINT_NAME} from ${fk.TABLE_NAME}`,
          );
        } catch (fkError) {
          this.logger.warn(
            `Failed to drop referencing FK ${fk.CONSTRAINT_NAME}: ${fkError.message}`,
          );
        }
      }

      // 4. Drop foreign keys FROM this table
      const outgoingFKs = await queryRunner.query(`
        SELECT CONSTRAINT_NAME
        FROM information_schema.KEY_COLUMN_USAGE
        WHERE CONSTRAINT_SCHEMA = DATABASE()
          AND TABLE_NAME = '${tableName}'
          AND REFERENCED_TABLE_NAME IS NOT NULL
      `);

      for (const fk of outgoingFKs) {
        try {
          await queryRunner.query(
            `ALTER TABLE \`${tableName}\` DROP FOREIGN KEY \`${fk.CONSTRAINT_NAME}\``,
          );
          this.logger.debug(`Dropped outgoing FK: ${fk.CONSTRAINT_NAME}`);
        } catch (fkError) {
          this.logger.warn(
            `Failed to drop outgoing FK ${fk.CONSTRAINT_NAME}: ${fkError.message}`,
          );
        }
      }

      // 5. Drop the physical database table
      const hasTable = await queryRunner.hasTable(tableName);
      if (hasTable) {
        await queryRunner.dropTable(tableName);
        this.logger.log(`✅ Database table ${tableName} dropped successfully`);
      } else {
        this.logger.warn(`Table ${tableName} does not exist in database`);
      }

      // 6. Finally, remove metadata record - this will cascade delete columns and source relations
      const result = await tableDefRepo.remove(exists);
      this.logger.log(`✅ Table definition removed with cascaded deletion of columns and relations`);

      await this.afterEffect({ entityName: result.name, type: 'update' });
      return result;
    } catch (error) {
      this.loggingService.error('Table deletion failed', {
        context: 'delete',
        error: error.message,
        stack: error.stack,
        tableId: id,
        tableName: exists?.name,
      });

      if (error.message?.includes('does not exist')) {
        throw new ResourceNotFoundException('Table', id.toString());
      }

      throw new DatabaseException(`Failed to delete table: ${error.message}`, {
        tableId: id,
        tableName: exists?.name,
        operation: 'delete',
      });
    } finally {
      await queryRunner.release();
    }
  }

  async afterEffect(options: {
    entityName: string;
    type: 'create' | 'update';
  }) {
    try {
      // Fire & forget syncAll - it will handle publish internally
      this.metadataSyncService.syncAll({
        entityName: options.entityName,
        type: options.type,
      }).catch(error => {
        this.logger.error('Background sync failed:', error.message);
      });

      this.logger.log('✅ Schema sync queued', { 
        entityName: options.entityName,
        type: options.type
      });
    } catch (error) {
      this.loggingService.error('Schema synchronization failed', {
        context: 'afterEffect',
        error: error.message,
        stack: error.stack,
        entityName: options.entityName,
        operationType: options.type,
      });

      throw new DatabaseException(
        `Schema synchronization failed: ${error.message}`,
        {
          entityName: options.entityName,
          operationType: options.type,
          operation: 'schema-sync',
        },
      );
    }
  }
}
